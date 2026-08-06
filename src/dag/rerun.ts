// dag_rerun library: build a "rerun view" from a V2 checkpoint — explicitly
// rerun a set of nodes (and their downstream closure) while reusing untouched
// node results. Mirrors Dagster FROM_FAILURE re-execution ("only failed steps
// and their downstreams"), GitHub Actions rerun ("a job and its dependent
// jobs"), and LangGraph fork (branch from a checkpoint with modified state).
//
// The view is a pure derivation: the checkpoint itself is never mutated, and
// the integrity validation that guards against forged checkpoints still runs
// on the ORIGINAL spec before any explicit rerun option is applied.

import type { DAGCheckpointNodeMode, DAGCheckpointNodeState, DAGCheckpointV2 } from "./checkpoint";
import type { DAGNode, DAGSpec, DispatchExpansionRecord, GeneratedNodeRecord, NodeResult } from "./types";

export interface DagRerunSpecPatch {
  /** New nodes keyed by id. Must satisfy DAG admission (task, contract). */
  add?: Record<string, DAGNode>;
  /** Node ids to remove, along with their incoming edges. */
  remove?: string[];
  /** Field-level overrides applied to existing nodes. */
  modify?: Record<string, Partial<DAGNode>>;
}

export interface DagRerunOptions {
  /** Nodes to rerun (with their downstream closure). Defaults to all failed
   *  nodes — Dagster FROM_FAILURE semantics. */
  rerunNodes?: string[];
  /** Failure/verification feedback injected into each node's task. */
  inject?: Record<string, string>;
  /** Structural changes (form C: add/remove/modify nodes). */
  specPatch?: DagRerunSpecPatch;
}

export interface DagRerunView {
  /** Patched + injected spec to execute (checkpoint's expandedSpec semantics). */
  spec: DAGSpec;
  initialNodeResults: Map<string, NodeResult>;
  initialNodeStates: Record<string, DAGCheckpointNodeState>;
  initialSkipReasons: Map<string, string>;
  initialGeneratedNodes: Record<string, GeneratedNodeRecord>;
  initialDispatchExpansions: Record<string, DispatchExpansionRecord>;
  initialNodeModes: Record<string, DAGCheckpointNodeMode>;
  /** Nodes actually reset to pending (requested nodes + downstream closure). */
  rerunClosure: string[];
  /** Nodes requested for rerun that do not exist in the spec (non-fatal). */
  unknownRerunNodes: string[];
}

function downstreamClosure(spec: DAGSpec, seeds: string[]): Set<string> {
  const closure = new Set<string>();
  const queue = [...new Set(seeds)];
  // Precompute reverse edges once: who depends on whom.
  const consumersOf = new Map<string, string[]>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    for (const dep of node.depends_on ?? []) {
      const list = consumersOf.get(dep) ?? [];
      list.push(id);
      consumersOf.set(dep, list);
    }
    for (const consumer of node.consumers ?? []) {
      if (consumer === "$result") continue;
      const list = consumersOf.get(id) ?? [];
      if (!list.includes(consumer)) list.push(consumer);
      consumersOf.set(id, list);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const downstream of consumersOf.get(id) ?? []) {
      if (!closure.has(downstream)) queue.push(downstream);
    }
  }
  return closure;
}

function applySpecPatch(spec: DAGSpec, patch: DagRerunSpecPatch): string[] {
  const errors: string[] = [];
  const nodes = spec.nodes;
  for (const [id, node] of Object.entries(patch.add ?? {})) {
    if (nodes[id]) { errors.push(`specPatch.add: node '${id}' already exists`); continue; }
    nodes[id] = node;
  }
  for (const id of patch.remove ?? []) {
    if (!nodes[id]) { errors.push(`specPatch.remove: unknown node '${id}'`); continue; }
    delete nodes[id];
    // Remove incoming edges from remaining nodes.
    for (const other of Object.values(nodes)) {
      other.depends_on = (other.depends_on ?? []).filter((dep) => dep !== id);
    }
  }
  for (const [id, overrides] of Object.entries(patch.modify ?? {})) {
    if (!nodes[id]) { errors.push(`specPatch.modify: unknown node '${id}'`); continue; }
    nodes[id] = { ...nodes[id], ...overrides };
  }
  return errors;
}

/** Pure derivation: checkpoint → rerun view. Throws on malformed options;
 *  returns {errors} for admission-style failures so the tool can report them. */
export function buildRerunView(
  checkpoint: DAGCheckpointV2,
  options: DagRerunOptions = {},
): DagRerunView | { errors: string[] } {
  const { rerunNodes, inject, specPatch } = options;
  const spec: DAGSpec = {
    ...checkpoint.expandedSpec,
    nodes: { ...checkpoint.expandedSpec.nodes },
  };

  const patchErrors: string[] = [];
  if (specPatch) {
    patchErrors.push(...applySpecPatch(spec, specPatch));
    if (patchErrors.length > 0) return { errors: patchErrors };
  }

  // Modified nodes must rerun (their output changed) — they join the seeds
  // alongside explicit rerunNodes or the FROM_FAILURE default.
  const modifiedSeeds = specPatch ? Object.keys(specPatch.modify ?? {}) : [];
  const defaultSeeds = Object.entries(checkpoint.nodeStates)
    .filter(([, state]) => state.status === "failed")
    .map(([id]) => id);
  const seeds = [...new Set([
    ...(rerunNodes !== undefined && rerunNodes.length > 0 ? rerunNodes : defaultSeeds),
    ...modifiedSeeds,
  ])];
  const unknownRerunNodes = seeds.filter((id) => !spec.nodes[id]);
  const knownSeeds = seeds.filter((id) => spec.nodes[id]);
  let closure = downstreamClosure(spec, knownSeeds);

  // Dynamic children of a rerun parent are regenerated by the parent — drop
  // them from the view so the rerun parent re-fans them out.
  const removedGenerated: string[] = [];
  for (const [childId, record] of Object.entries(checkpoint.generatedNodes)) {
    if (closure.has(record.parentId)) {
      closure.add(childId);
      removedGenerated.push(childId);
    }
  }

  // Apply inject feedback into rerun node tasks.
  if (inject) {
    for (const [id, feedback] of Object.entries(inject)) {
      if (!closure.has(id)) continue; // only inject into nodes actually rerunning
      const node = spec.nodes[id];
      if (!node) continue;
      spec.nodes[id] = { ...node, task: `${node.task}\n\n<RERUN-FEEDBACK>\n${feedback}\n</RERUN-FEEDBACK>` };
    }
  }

  const initialNodeResults = new Map<string, NodeResult>();
  const initialNodeStates: Record<string, DAGCheckpointNodeState> = {};
  for (const [id, state] of Object.entries(checkpoint.nodeStates)) {
    if (!spec.nodes[id]) continue; // removed by patch
    if (closure.has(id)) {
      initialNodeStates[id] = { status: "queued" };
      continue;
    }
    initialNodeStates[id] = state;
    if (state.status === "completed" || state.status === "failed" || state.status === "skipped") {
      initialNodeResults.set(id, {
        nodeId: id,
        status: state.status,
        result: state.result,
        error: state.error,
      });
    }
  }

  const initialSkipReasons = new Map<string, string>();
  for (const [id, reason] of Object.entries(checkpoint.skipReasons)) {
    if (spec.nodes[id] && !closure.has(id)) initialSkipReasons.set(id, reason);
  }

  const initialGeneratedNodes: Record<string, GeneratedNodeRecord> = {};
  for (const [id, record] of Object.entries(checkpoint.generatedNodes)) {
    if (spec.nodes[id] && !closure.has(id)) initialGeneratedNodes[id] = record;
  }
  const initialDispatchExpansions: Record<string, DispatchExpansionRecord> = {};
  for (const [id, record] of Object.entries(checkpoint.dispatchExpansions)) {
    if (spec.nodes[id] && !closure.has(id)) initialDispatchExpansions[id] = record;
  }

  return {
    spec,
    initialNodeResults,
    initialNodeStates,
    initialSkipReasons,
    initialGeneratedNodes,
    initialDispatchExpansions,
    initialNodeModes: checkpoint.nodeModes,
    rerunClosure: [...closure],
    unknownRerunNodes,
  };
}
