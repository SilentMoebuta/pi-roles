// V1 checkpoints persist completed waves. V2 persists explicit per-node state,
// so ready scheduling can resume after any settled node rather than a barrier.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md §5e.
//
// resumeDAG delegates to executeDAGCore, keeping scheduling and error behavior
// identical between fresh and resumed runs.

import type {
  DAGExecutionSnapshot,
  DAGNodeExecutionMode,
  DAGNodeState,
  DAGScheduler,
  DispatchExpansionRecord,
  GeneratedNodeRecord,
  WaveResult,
  NodeResult,
  DAGResult,
  DAGSpec,
  WorkflowLineage,
} from "./types";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { planWaves } from "./planner";
import { executeDAGCore, mergePayloads, type ExecuteOptions, type SpawnFn } from "./executor";
import { computeSkipReasonsFromResults } from "./route-skip";
import { expandDispatchNode, generatedNodeId } from "./expansion";
import type { Send } from "./send";
import {
  DEFAULT_MAX_DISPATCH_CHILDREN,
  HARD_MAX_DISPATCH_CHILDREN,
  validateGeneratedSends,
} from "./validate";

/** Serializable checkpoint: the spec + waves completed so far + their results. */
export interface DAGCheckpointV1 {
  spec: DAGSpec;
  completedWaves: WaveResult[];
}

export interface DAGCheckpointNodeState extends DAGNodeState {
  result?: NodeResult["result"];
  /** Full envelope for stable workflow/node lineage. Legacy checkpoints only
   * carry result and are upgraded during resume. */
  nodeResult?: NodeResult;
}

export type DAGCheckpointNodeMode = DAGNodeExecutionMode;

export interface DAGCheckpointV2 {
  version: 2;
  workflow?: WorkflowLineage;
  /** Original admitted graph, retained for audit and compatibility. */
  spec: DAGSpec;
  /** Runtime graph including scheduler-visible generated children. */
  expandedSpec: DAGSpec;
  scheduler: DAGScheduler;
  nodeStates: Record<string, DAGCheckpointNodeState>;
  /** Serializable execution origin for every original node. This prevents a
   * lost dynamic closure from silently becoming a normal/result spawn. */
  nodeModes: Record<string, DAGCheckpointNodeMode>;
  skipReasons: Record<string, string>;
  generatedNodes: Record<string, GeneratedNodeRecord>;
  dispatchExpansions: Record<string, DispatchExpansionRecord>;
  /** P1 durable runtime material; optional keeps V2 checkpoints decodable. */
  artifactDigests?: DAGExecutionSnapshot["artifactDigests"];
  approvals?: DAGExecutionSnapshot["approvals"];
  sideEffectJournal?: DAGExecutionSnapshot["sideEffectJournal"];
  /** SHA-256 over the checkpoint body; absent only on legacy V2 data. */
  checkpointDigest?: string;
  /** Dynamic closures cannot survive JSON serialization. */
  unresolvedDynamicNodes?: string[];
}

export type DAGCheckpoint = DAGCheckpointV1 | DAGCheckpointV2;

/** Serialize a checkpoint to a JSON string. */
export function serializeCheckpoint(cp: DAGCheckpoint): string {
  return JSON.stringify(cp);
}

/** Deserialize a checkpoint from a JSON string. Throws on malformed input. */
export function deserializeCheckpoint(json: string): DAGCheckpoint {
  const cp = JSON.parse(json) as DAGCheckpoint;
  if (!cp || typeof cp !== "object" || !(cp as DAGCheckpointV1).spec) {
    throw new Error("malformed checkpoint: missing spec");
  }
  if ((cp as DAGCheckpointV2).version === 2) {
    const v2 = cp as DAGCheckpointV2;
    if (!v2.nodeStates || typeof v2.nodeStates !== "object" || !v2.skipReasons || typeof v2.skipReasons !== "object") {
      throw new Error("malformed V2 checkpoint: missing nodeStates or skipReasons");
    }
    if (v2.scheduler !== "ready" && v2.scheduler !== "wave") {
      throw new Error("malformed V2 checkpoint: invalid scheduler");
    }
    v2.expandedSpec ??= v2.spec;
    v2.generatedNodes ??= {};
    v2.dispatchExpansions ??= {};
    if (!v2.expandedSpec?.nodes || typeof v2.expandedSpec.nodes !== "object"
      || !v2.nodeModes || typeof v2.nodeModes !== "object"
      || !v2.generatedNodes || typeof v2.generatedNodes !== "object"
      || !v2.dispatchExpansions || typeof v2.dispatchExpansions !== "object") {
      throw new Error("malformed V2 checkpoint: invalid expansion metadata");
    }
    if ((v2.unresolvedDynamicNodes?.length ?? 0) > 0) {
      throw new Error(`non-resumable V2 checkpoint: unresolved dynamic nodes ${v2.unresolvedDynamicNodes!.join(", ")}`);
    }
    validateV2Topology(v2);
    // Preserve the existing structural diagnostics first; once topology and
    // lineage are mechanically valid, the body digest detects content edits
    // such as forged approvals or side-effect receipts.
    if (v2.checkpointDigest !== undefined && v2.checkpointDigest !== checkpointDigest(v2)) {
      throw new Error("malformed V2 checkpoint: checkpoint digest mismatch");
    }
    return v2;
  }
  if ("version" in (cp as object)) {
    throw new Error(`unsupported checkpoint version '${String((cp as { version?: unknown }).version)}'`);
  }
  if (!Array.isArray((cp as DAGCheckpointV1).completedWaves)) {
    throw new Error("malformed checkpoint: missing completedWaves");
  }
  return cp;
}

/** Build a checkpoint from a partial DAG run (waves completed so far). */
export function makeCheckpoint(spec: DAGSpec, completedWaves: WaveResult[]): DAGCheckpointV1 {
  return { spec, completedWaves };
}

function cloneDispatchExpansion(record: DispatchExpansionRecord): DispatchExpansionRecord {
  return {
    ...record,
    generatedNodeIds: [...record.generatedNodeIds],
    sends: record.sends.map((send) => structuredClone(send)),
    dispatcherResult: record.dispatcherResult ? structuredClone(record.dispatcherResult) : undefined,
  };
}

export function makeCheckpointV2(spec: DAGSpec, snapshot: DAGExecutionSnapshot): DAGCheckpointV2 {
  const nodeStates: Record<string, DAGCheckpointNodeState> = {};
  for (const [id, state] of Object.entries(snapshot.nodeStates)) {
    nodeStates[id] = { ...state, result: snapshot.nodeResults[id]?.result, nodeResult: snapshot.nodeResults[id] };
  }
  const checkpoint: DAGCheckpointV2 = {
    version: 2,
    ...(snapshot.workflow ? { workflow: snapshot.workflow } : {}),
    spec,
    expandedSpec: snapshot.expandedSpec,
    scheduler: snapshot.scheduler,
    nodeStates,
    nodeModes: Object.fromEntries(Object.entries(spec.nodes).map(([id, node]) => [id,
      snapshot.nodeModes?.[id]
        ?? (typeof node.dynamic === "function"
          ? "dynamic"
          : node.sends !== undefined
            ? "sends"
            : node.dispatch !== undefined
              ? "result_dispatch"
              : "spawn"),
    ])),
    skipReasons: { ...snapshot.skipReasons },
    generatedNodes: { ...snapshot.generatedNodes },
    dispatchExpansions: Object.fromEntries(Object.entries(snapshot.dispatchExpansions).map(([id, record]) => [id, cloneDispatchExpansion(record)])),
    artifactDigests: structuredClone(snapshot.artifactDigests ?? {}),
    approvals: structuredClone(snapshot.approvals ?? {}),
    sideEffectJournal: structuredClone(snapshot.sideEffectJournal ?? {}),
    unresolvedDynamicNodes: Object.entries(snapshot.expandedSpec.nodes)
      .filter(([id, node]) => typeof node.dynamic === "function"
        && !snapshot.dispatchExpansions[id]
        && snapshot.nodeStates[id]?.status !== "completed"
        && snapshot.nodeStates[id]?.status !== "failed"
        && snapshot.nodeStates[id]?.status !== "skipped")
      .map(([id]) => id),
  };
  checkpoint.checkpointDigest = checkpointDigest(checkpoint);
  return checkpoint;
}

function checkpointDigest(value: DAGCheckpointV2): string {
  const { checkpointDigest: _ignored, ...body } = value;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function validateV2Topology(checkpoint: DAGCheckpointV2): void {
  const ids = new Set(Object.keys(checkpoint.expandedSpec.nodes));
  const originalIds = new Set(Object.keys(checkpoint.spec.nodes));
  const allowedStatuses = new Set(["queued", "running", "completed", "failed", "skipped"]);
  const allowedModes = new Set<DAGCheckpointNodeMode>(["spawn", "sends", "dynamic", "result_dispatch"]);
  for (const id of Object.keys(checkpoint.nodeStates)) {
    if (!ids.has(id)) throw new Error(`malformed V2 checkpoint: state for unknown node '${id}'`);
    if (!allowedStatuses.has(checkpoint.nodeStates[id].status)) {
      throw new Error(`malformed V2 checkpoint: invalid state for node '${id}'`);
    }
  }
  for (const id of ids) {
    if (!checkpoint.nodeStates[id]) throw new Error(`malformed V2 checkpoint: missing state for node '${id}'`);
    if (checkpoint.nodeStates[id].status === "completed" && !checkpoint.nodeStates[id].result) {
      throw new Error(`malformed V2 checkpoint: completed node '${id}' has no result`);
    }
    if (!originalIds.has(id) && !checkpoint.generatedNodes[id]) {
      throw new Error(`malformed V2 checkpoint: expanded node '${id}' has no generated record`);
    }
  }
  for (const id of originalIds) {
    if (!ids.has(id)) throw new Error(`malformed V2 checkpoint: original node '${id}' is missing from expandedSpec`);
    const mode = checkpoint.nodeModes[id];
    const node = checkpoint.spec.nodes[id];
    const expansion = checkpoint.dispatchExpansions[id];
    if (!allowedModes.has(mode)) throw new Error(`malformed V2 checkpoint: missing or invalid execution mode for node '${id}'`);
    if (mode === "spawn" && (node.sends !== undefined || node.dispatch !== undefined)) {
      throw new Error(`malformed V2 checkpoint: spawn mode conflicts with node '${id}'`);
    }
    if (mode === "sends" && node.sends === undefined) {
      throw new Error(`malformed V2 checkpoint: sends mode conflicts with node '${id}'`);
    }
    if (mode === "result_dispatch" && (node.dispatch === undefined || node.sends !== undefined)) {
      throw new Error(`malformed V2 checkpoint: result dispatch mode conflicts with node '${id}'`);
    }
    if (expansion && ((mode === "sends" && expansion.source !== "sends")
      || (mode === "dynamic" && expansion.source !== "dynamic")
      || (mode === "result_dispatch" && expansion.source !== "result"))) {
      throw new Error(`malformed V2 checkpoint: execution mode conflicts with expansion '${id}'`);
    }
    if (mode === "dynamic" && !expansion
      && checkpoint.nodeStates[id].status !== "completed"
      && checkpoint.nodeStates[id].status !== "failed"
      && checkpoint.nodeStates[id].status !== "skipped") {
      throw new Error(`non-resumable V2 checkpoint: unresolved dynamic node ${id}`);
    }
  }
  for (const id of Object.keys(checkpoint.nodeModes)) {
    if (!originalIds.has(id)) throw new Error(`malformed V2 checkpoint: execution mode for unknown node '${id}'`);
  }
  for (const id of Object.keys(checkpoint.skipReasons)) {
    if (!ids.has(id)) throw new Error(`malformed V2 checkpoint: skip reason for unknown node '${id}'`);
  }
  let rebuiltSpec = checkpoint.spec;
  let rebuiltGenerated: Record<string, GeneratedNodeRecord> = {};
  for (const [parentId, expansion] of Object.entries(checkpoint.dispatchExpansions)) {
    if (!expansion || expansion.parentId !== parentId || !ids.has(parentId) || !Array.isArray(expansion.generatedNodeIds)
      || !Array.isArray(expansion.sends)
      || (expansion.source !== "sends" && expansion.source !== "dynamic" && expansion.source !== "result")) {
      throw new Error(`malformed V2 checkpoint: invalid dispatch expansion '${parentId}'`);
    }
    const originalParent = checkpoint.spec.nodes[parentId];
    if (!originalParent?.dispatch) {
      throw new Error(`malformed V2 checkpoint: expansion '${parentId}' has no original dispatch contract`);
    }
    const maxChildren = originalParent.dispatch.maxChildren ?? DEFAULT_MAX_DISPATCH_CHILDREN;
    if (!Number.isInteger(maxChildren) || maxChildren < 1 || maxChildren > HARD_MAX_DISPATCH_CHILDREN
      || expansion.generatedNodeIds.length > maxChildren || expansion.sends.length > maxChildren) {
      throw new Error(`malformed V2 checkpoint: expansion '${parentId}' exceeds its dispatch bound`);
    }
    const sendErrors = validateGeneratedSends(parentId, expansion.sends, true);
    if (sendErrors.length > 0) {
      throw new Error(`malformed V2 checkpoint: invalid expansion '${parentId}': ${sendErrors.join("; ")}`);
    }
    const expectedIds = expansion.sends.map((send) => generatedNodeId(parentId, send.key ?? ""));
    if (!isDeepStrictEqual(expansion.generatedNodeIds, expectedIds)) {
      throw new Error(`malformed V2 checkpoint: expansion '${parentId}' does not match its persisted sends`);
    }
    if (expansion.source === "sends") {
      if (originalParent.sends === undefined) {
        throw new Error(`malformed V2 checkpoint: expansion '${parentId}' is missing original sends`);
      }
      if (!isDeepStrictEqual(expansion.sends, originalParent.sends)) {
        throw new Error(`malformed V2 checkpoint: expansion '${parentId}' does not match original sends`);
      }
    } else if (originalParent.sends !== undefined) {
      throw new Error(`malformed V2 checkpoint: dynamic expansion '${parentId}' conflicts with original sends`);
    }
    if (expansion.source === "result") {
      const sends = expansion.dispatcherResult?.sends;
      if (!expansion.dispatcherResult || !Array.isArray(sends)) {
        throw new Error(`malformed V2 checkpoint: result expansion '${parentId}' has no dispatcher sends payload`);
      }
      if (!isDeepStrictEqual(expansion.sends, sends as Send[])) {
        throw new Error(`malformed V2 checkpoint: result expansion '${parentId}' does not match dispatcher sends`);
      }
    } else if (expansion.dispatcherResult !== undefined) {
      throw new Error(`malformed V2 checkpoint: non-result expansion '${parentId}' carries a dispatcher result`);
    }
    try {
      const rebuilt = expandDispatchNode(rebuiltSpec, parentId, expansion.sends, rebuiltGenerated);
      rebuiltSpec = rebuilt.spec;
      rebuiltGenerated = rebuilt.generatedNodes;
    } catch (error) {
      throw new Error(`malformed V2 checkpoint: cannot rebuild expansion '${parentId}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const jsonRebuiltSpec = JSON.parse(JSON.stringify(rebuiltSpec)) as DAGSpec;
  const jsonRebuiltGenerated = JSON.parse(JSON.stringify(rebuiltGenerated)) as Record<string, GeneratedNodeRecord>;
  if (!isDeepStrictEqual(checkpoint.expandedSpec, jsonRebuiltSpec)) {
    throw new Error("malformed V2 checkpoint: expandedSpec does not match the mechanically rebuilt topology");
  }
  if (!isDeepStrictEqual(checkpoint.generatedNodes, jsonRebuiltGenerated)) {
    throw new Error("malformed V2 checkpoint: generatedNodes do not match the mechanically rebuilt topology");
  }

  for (const [parentId, expansion] of Object.entries(checkpoint.dispatchExpansions)) {
    const parentState = checkpoint.nodeStates[parentId];
    if (parentState.status === "skipped") {
      throw new Error(`malformed V2 checkpoint: expanded dispatch '${parentId}' cannot be skipped`);
    }
    const allChildrenTerminal = expansion.generatedNodeIds.every((id) =>
      checkpoint.nodeStates[id].status === "completed"
      || checkpoint.nodeStates[id].status === "failed"
      || checkpoint.nodeStates[id].status === "skipped");
    if ((parentState.status === "completed" || parentState.status === "failed")
      && !allChildrenTerminal) {
      throw new Error(`malformed V2 checkpoint: terminal dispatch '${parentId}' has non-terminal children`);
    }
    const allChildrenCompleted = expansion.generatedNodeIds.every((id) => checkpoint.nodeStates[id].status === "completed");
    if (parentState.status === "completed" && !allChildrenCompleted) {
      throw new Error(`malformed V2 checkpoint: completed dispatch '${parentId}' has non-completed children`);
    }
    if (parentState.status === "failed" && allChildrenCompleted) {
      throw new Error(`malformed V2 checkpoint: failed dispatch '${parentId}' has only completed children`);
    }
    if (parentState.status === "completed" && !parentState.result) {
      throw new Error(`malformed V2 checkpoint: completed dispatch '${parentId}' has no aggregate result`);
    }
    if (parentState.status === "completed") {
      const childPayloads = expansion.generatedNodeIds.map((id) => checkpoint.nodeStates[id].result!);
      const expected = mergePayloads(expansion.dispatcherResult
        ? [expansion.dispatcherResult, ...childPayloads]
        : childPayloads);
      if (!isDeepStrictEqual(parentState.result, expected)) {
        throw new Error(`malformed V2 checkpoint: completed dispatch '${parentId}' aggregate result does not match its children`);
      }
    }
  }

  // Persisted route decisions must carry exactly the skip frontier they imply.
  // Missing entries run unselected work; extra entries suppress selected work.
  const expectedSkippedTargets = new Set<string>();
  for (const [id, node] of Object.entries(checkpoint.expandedSpec.nodes)) {
    if (!node.routes) continue;
    const state = checkpoint.nodeStates[id];
    if (!state) continue;
    const allTargets = new Set(Object.values(node.routes).flat());
    let skippedTargets: Set<string> | undefined;
    if (state.status === "completed") {
      const route = state.result?.route;
      const selected = typeof route === "string" && route.length > 0 ? node.routes[route] : undefined;
      if (!selected) {
        throw new Error(`malformed V2 checkpoint: completed route node '${id}' has an invalid route`);
      }
      skippedTargets = new Set([...allTargets].filter((target) => !selected.includes(target)));
    } else if (state.status === "failed"
      && (state.error === "missing route in node result" || state.error?.startsWith("unknown route '") === true)) {
      if (state.result !== undefined) {
        throw new Error(`malformed V2 checkpoint: failed route node '${id}' retains a completed result`);
      }
      skippedTargets = allTargets;
    }
    for (const target of skippedTargets ?? []) expectedSkippedTargets.add(target);
  }
  const actualSkippedTargets = new Set(Object.keys(checkpoint.skipReasons));
  if (expectedSkippedTargets.size !== actualSkippedTargets.size
    || [...expectedSkippedTargets].some((target) => !actualSkippedTargets.has(target))) {
    throw new Error("malformed V2 checkpoint: persisted route skip frontier does not match terminal route decisions");
  }
  for (const id of ids) {
    const state = checkpoint.nodeStates[id];
    const hasSkipReason = actualSkippedTargets.has(id);
    if (state.status === "skipped" && !hasSkipReason) {
      throw new Error(`malformed V2 checkpoint: skipped node '${id}' has no route skip reason`);
    }
    if (hasSkipReason && state.status !== "queued" && state.status !== "skipped") {
      throw new Error(`malformed V2 checkpoint: route-skipped node '${id}' has impossible status '${state.status}'`);
    }
    if (state.status === "skipped" && state.error !== checkpoint.skipReasons[id]) {
      throw new Error(`malformed V2 checkpoint: skipped node '${id}' does not match its route skip reason`);
    }
  }
}

/**
 * Resume a DAG from a checkpoint: skip the already-completed waves and run
 * the remaining waves with prior results preserved. Delegates to the SAME
 * wave loop as executeDAG (via executeDAGCore), so dynamic nodes (5c) and
 * error-context propagation (5d) work identically on resume.
 *
 * NOTE: unresolved `dynamic` closures are marked non-resumable because JSON
 * cannot preserve executable code. Once expanded, their generated topology is
 * ordinary data and resumes across processes without replaying the dispatcher.
 */
export async function resumeDAG(
  checkpoint: DAGCheckpoint,
  spawnFn: SpawnFn,
  opts: Pick<ExecuteOptions, "maxConcurrent" | "scheduler" | "knownRoles" | "onProgress" | "onCheckpoint" | "signal" | "now" | "retryPolicy" | "onAttempt"> = {},
): Promise<DAGResult> {
  if ((checkpoint as DAGCheckpointV2).version === 2) {
    const cp = checkpoint as DAGCheckpointV2;
    const initialNodeResults = new Map<string, NodeResult>();
    for (const [id, state] of Object.entries(cp.nodeStates)) {
      if (state.status === "completed" || state.status === "failed" || state.status === "skipped") {
        initialNodeResults.set(id, {
          ...(state.nodeResult ?? {
            nodeId: id,
            status: state.status,
            result: state.result,
            error: state.error,
          }),
        });
      }
    }
    return executeDAGCore(cp.expandedSpec ?? cp.spec, spawnFn, {
      ...opts,
      workflow: cp.workflow,
      scheduler: opts.scheduler ?? cp.scheduler,
      initialNodeResults,
      initialNodeStates: cp.nodeStates,
      initialSkipReasons: new Map(Object.entries(cp.skipReasons)),
      initialGeneratedNodes: cp.generatedNodes ?? {},
      initialDispatchExpansions: cp.dispatchExpansions ?? {},
      initialNodeModes: cp.nodeModes,
      checkpointRuntime: { artifactDigests: cp.artifactDigests, approvals: cp.approvals, sideEffectJournal: cp.sideEffectJournal },
    });
  }

  const { spec, completedWaves } = checkpoint as DAGCheckpointV1;
  const allWaves = planWaves(spec);
  if (completedWaves.length > allWaves.length) {
    throw new Error(`checkpoint has ${completedWaves.length} waves but spec only has ${allWaves.length}`);
  }

  // Seed nodeResults from the checkpoint so downstream nodes see upstream state.
  const initialNodeResults = new Map<string, NodeResult>();
  for (const w of completedWaves) {
    for (const s of w.successes) initialNodeResults.set(s.nodeId, s);
    for (const f of w.failures) initialNodeResults.set(f.nodeId, f);
  }

  // Recompute route skipReasons from the persisted routing-node results so
  // unselected branches stay skipped after resume (route×checkpoint fix).
  // result.route survived checkpoint via mergePayloads' Object.assign path.
  const initialSkipReasons = computeSkipReasonsFromResults(spec, initialNodeResults);

  return executeDAGCore(spec, spawnFn, {
    ...opts,
    scheduler: opts.scheduler ?? "ready",
    initialNodeResults,
    initialSkipReasons,
    startWaveIndex: completedWaves.length,
    priorWaveResults: completedWaves,
  });
}
