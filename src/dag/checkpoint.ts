// Phase 5e: Per-wave checkpoint. After each wave completes, the DAG state
// (completed waves + their node results) can be serialized to a JSON string.
// If the executor crashes, resume from the last checkpoint: skip already-
// completed waves and continue with prior results preserved.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md §5e.

import type { WaveResult, NodeResult, DAGResult, DAGSpec } from "./types";
import { planWaves } from "./planner";
import { aggregateWaves } from "./state";
import type { SpawnFn } from "./executor";

/** Serializable checkpoint: the spec + waves completed so far + their results. */
export interface DAGCheckpoint {
  spec: DAGSpec;
  completedWaves: WaveResult[];
}

/** Serialize a checkpoint to a JSON string. */
export function serializeCheckpoint(cp: DAGCheckpoint): string {
  return JSON.stringify(cp);
}

/** Deserialize a checkpoint from a JSON string. Throws on malformed input. */
export function deserializeCheckpoint(json: string): DAGCheckpoint {
  const cp = JSON.parse(json) as DAGCheckpoint;
  if (!cp || typeof cp !== "object" || !cp.spec || !Array.isArray(cp.completedWaves)) {
    throw new Error("malformed checkpoint: missing spec or completedWaves");
  }
  return cp;
}

/** Build a checkpoint from a partial DAG run (waves completed so far). */
export function makeCheckpoint(spec: DAGSpec, completedWaves: WaveResult[]): DAGCheckpoint {
  return { spec, completedWaves };
}

/**
 * Resume a DAG from a checkpoint: skip the already-completed waves and run
 * the remaining waves with prior results preserved (so downstream nodes see
 * upstream results + error context from completed waves). Returns the final
 * DAGResult including BOTH the checkpointed waves and the newly-run waves.
 *
 * Implementation: seed nodeResults from the checkpoint, plan all waves, then
 * execute only those with index >= completedWaves.length.
 */
export async function resumeDAG(
  checkpoint: DAGCheckpoint,
  spawnFn: SpawnFn,
): Promise<DAGResult> {
  const { spec, completedWaves } = checkpoint;
  const allWaves = planWaves(spec);
  if (completedWaves.length > allWaves.length) {
    throw new Error(`checkpoint has ${completedWaves.length} waves but spec only has ${allWaves.length}`);
  }

  // Seed node results from the checkpoint so downstream nodes see upstream state.
  const nodeResults = new Map<string, NodeResult>();
  for (const w of completedWaves) {
    for (const s of w.successes) nodeResults.set(s.nodeId, s);
    for (const f of w.failures) nodeResults.set(f.nodeId, f);
  }

  // Reuse the executor's wave logic for the remaining waves. We inline a
  // minimal version here to avoid a circular import (executor → state → ...).
  const { executeDAG } = await import("./executor");
  // Build a sub-spec of only the NOT-yet-run nodes, then run it. But executeDAG
  // re-plans from scratch and re-seeds nodeResults empty — so instead we run the
  // remaining waves directly here, mirroring executor.ts's wave body.
  const newWaveResults: WaveResult[] = [];
  // errorContextPrefix duplicated from state.ts to avoid dynamic import cost;
  // (state.ts is pure, no cycle, but inlining keeps resume self-contained.)
  const errPrefix = (failedNode: string, errorMessage: string) =>
    `\n[Predecessor '${failedNode}' failed: ${errorMessage}]. Decide: retry, skip, fallback, or escalate.`;

  for (let i = completedWaves.length; i < allWaves.length; i++) {
    const wave = allWaves[i];
    const spawned = await Promise.allSettled(
      wave.nodes.map(async (n) => {
        let task = n.task;
        const failedDeps = n.deps.filter((d) => nodeResults.get(d)?.status === "failed");
        for (const d of failedDeps) task += errPrefix(d, nodeResults.get(d)!.error ?? "unknown");
        const h = await spawnFn(n.role, task);
        return { nodeId: n.id, h };
      }),
    );
    const successes: NodeResult[] = [];
    const failures: NodeResult[] = [];
    const toWait: { nodeId: string; h: { wait: () => Promise<any> } }[] = [];
    spawned.forEach((res, idx) => {
      const nodeId = wave.nodes[idx].id;
      if (res.status === "rejected") {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr); nodeResults.set(nodeId, nr);
      } else {
        toWait.push({ nodeId, h: res.value.h });
      }
    });
    const settled = await Promise.allSettled(toWait.map(({ h }) => h.wait()));
    settled.forEach((res, idx) => {
      const { nodeId } = toWait[idx];
      if (res.status === "fulfilled") {
        const r = res.value;
        if (r.status === "completed") {
          const payload = r.reportPayload ?? r.result ?? { findings: [], artifacts: [] };
          const nr: NodeResult = { nodeId, status: "completed", result: payload };
          successes.push(nr); nodeResults.set(nodeId, nr);
        } else {
          const nr: NodeResult = { nodeId, status: "failed", error: r.error ?? r.status };
          failures.push(nr); nodeResults.set(nodeId, nr);
        }
      } else {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr); nodeResults.set(nodeId, nr);
      }
    });
    newWaveResults.push({ wave: i, successes, failures });
  }

  return aggregateWaves([...completedWaves, ...newWaveResults]);
}
