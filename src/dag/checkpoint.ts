// Phase 5e: Per-wave checkpoint. After each wave completes, the DAG state
// (completed waves + their node results) can be serialized to a JSON string.
// If the executor crashes, resume from the last checkpoint: skip already-
// completed waves and continue with prior results preserved.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md §5e.
//
// resumeDAG delegates to executor's executeDAGCore (same wave loop, dynamic-node
// support, allSettled isolation, error-context propagation) — NO logic is
// duplicated, so a resumed DAG behaves identically to a fresh one past the
// checkpointed waves (including dynamic nodes in pending waves).

import type { WaveResult, NodeResult, DAGResult, DAGSpec } from "./types";
import { planWaves } from "./planner";
import { executeDAGCore } from "./executor";

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
 * the remaining waves with prior results preserved. Delegates to the SAME
 * wave loop as executeDAG (via executeDAGCore), so dynamic nodes (5c) and
 * error-context propagation (5d) work identically on resume.
 *
 * NOTE: `dynamic` closures are NOT JSON-serializable, so a checkpoint that was
 * serialized + deserialized loses dynamic nodes in PENDING (not-yet-run) waves.
 * In-memory resume (no serialization round-trip) preserves them. Cross-process
 * resume of dynamic DAGs is a future concern (would need serializable node specs).
 */
export async function resumeDAG(
  checkpoint: DAGCheckpoint,
  spawnFn: (role: string | undefined, task: string) => Promise<{ agentId: string; wait: () => Promise<any> }>,
): Promise<DAGResult> {
  const { spec, completedWaves } = checkpoint;
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

  return executeDAGCore(spec, spawnFn, {
    initialNodeResults,
    startWaveIndex: completedWaves.length,
    priorWaveResults: completedWaves,
  });
}
