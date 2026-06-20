// Phase 5b DAG executor: topological waves, each wave spawns all nodes in
// parallel and barriers on Promise.allSettled. BOTH the spawn phase AND the
// wait phase use allSettled, so a rejecting spawnFn OR a failing wait cannot
// abort sibling nodes (Phase 5b isolation guarantee — a node's failure is its
// own, not its wave's). Downstream nodes whose predecessor failed receive an
// error-context prefix on their task (5d). Uses an injected spawnFn so it
// never touches AgentHandle and stays structuredClone-safe.
import type { DAGSpec, WaveResult, NodeResult, DAGResult } from "./types";
import { planWaves } from "./planner";
import { aggregateWaves, errorContextPrefix } from "./state";
import { fanOutSends } from "./send";

export type SpawnOutcomeStatus = "completed" | "aborted" | "error" | "failed";

export interface SpawnHandle {
  // agentId is the spawn's id (reserved for future Teams/handle use); the
  // executor keys nodes by nodeId (from the DAG spec), NOT by agentId.
  agentId: string;
  wait: () => Promise<{
    status: SpawnOutcomeStatus;
    result?: { findings: string[]; artifacts: string[] };
    error?: string;
    reportPayload?: { findings: string[]; artifacts: string[] };
  }>;
}

export type SpawnFn = (role: string, task: string) => Promise<SpawnHandle>;

/** Internal options shared by executeDAG and resumeDAG (5e delegates to core). */
interface ExecuteOptions {
  /** Results already known (from a checkpoint) — seeds nodeResults so downstream
   *  nodes see upstream state. Used by resumeDAG. */
  initialNodeResults?: Map<string, NodeResult>;
  /** Skip waves before this index (already completed in a checkpoint). */
  startWaveIndex?: number;
  /** Wave results carried over from the checkpoint (prepended to the result). */
  priorWaveResults?: WaveResult[];
}

export async function executeDAGCore(spec: DAGSpec, spawnFn: SpawnFn, opts: ExecuteOptions = {}): Promise<DAGResult> {
  const waves = planWaves(spec);
  const waveResults: WaveResult[] = [...(opts.priorWaveResults ?? [])];
  const nodeResults = new Map<string, NodeResult>(opts.initialNodeResults ?? []);
  const startWaveIndex = opts.startWaveIndex ?? 0;

  for (let wi = startWaveIndex; wi < waves.length; wi++) {
    const wave = waves[wi];
    // PARALLEL spawn (allSettled — a rejecting spawnFn does NOT abort siblings).
    // A node may be static (1 handle) or dynamic (Phase 5c: returns Send[] → N handles).
    const spawned = await Promise.allSettled(
      wave.nodes.map(async (n) => {
        let task = n.task;
        const failedDeps = n.deps.filter((d) => nodeResults.get(d)?.status === "failed");
        for (const d of failedDeps) {
          task += errorContextPrefix(d, nodeResults.get(d)!.error ?? "unknown");
        }
        let handles: SpawnHandle[];
        if (n.dynamic) {
          // Phase 5c: dynamic node — invoke to get Send[], fan out in parallel.
          const deps: Record<string, { findings: string[]; artifacts: string[] }> = {};
          for (const d of n.deps ?? []) {
            const nr = nodeResults.get(d);
            if (nr?.status === "completed" && nr.result) deps[d] = nr.result;
          }
          const sends = await n.dynamic({ nodeId: n.id, dependencies: deps });
          const fanned = await fanOutSends(sends, spawnFn);
          // fanOutSends uses allSettled: a rejecting Send → undefined. Replace
          // undefined with a synthetic failed handle so the wait phase marks
          // the dynamic node failed (per-Send isolation, mirrors spawn allSettled).
          handles = fanned.map((h, i) => h ?? {
            agentId: `failed-send-${i}`,
            wait: async () => ({ status: "failed" as const, error: "send spawn rejected" }),
          });
        } else {
          handles = [await spawnFn(n.role, task)];
        }
        return { nodeId: n.id, handles };
      }),
    );

    // Partition: rejected spawns → immediate failed NodeResult; fulfilled → wait.
    const successes: NodeResult[] = [];
    const failures: NodeResult[] = [];
    const toWait: { nodeId: string; handles: SpawnHandle[] }[] = [];
    spawned.forEach((res, i) => {
      const nodeId = wave.nodes[i].id;
      if (res.status === "rejected") {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      } else {
        toWait.push({ nodeId, handles: res.value.handles });
      }
    });

    // BARRIER: wait for all spawned nodes (allSettled — a failing wait does NOT abort siblings).
    // A dynamic node's N handles are all awaited; their payloads are merged into one NodeResult.
    const settled = await Promise.allSettled(toWait.flatMap(({ handles }) => handles.map((h) => h.wait())));
    // Map each settled result back to its nodeId (handles were flattened in toWait order).
    let flatIdx = 0;
    for (const { nodeId, handles } of toWait) {
      const subResults: { findings: string[]; artifacts: string[] }[] = [];
      let subError: string | undefined;
      let allCompleted = true;
      for (let j = 0; j < handles.length; j++) {
        const res = settled[flatIdx++];
        if (res.status === "fulfilled" && res.value.status === "completed") {
          subResults.push(res.value.reportPayload ?? res.value.result ?? { findings: [], artifacts: [] });
        } else {
          allCompleted = false;
          subError = res.status === "fulfilled" ? (res.value.error ?? res.value.status) : (res.reason instanceof Error ? res.reason.message : String(res.reason));
        }
      }
      if (allCompleted) {
        const merged: NodeResult = {
          nodeId,
          status: "completed",
          result: {
            findings: subResults.flatMap((r) => r.findings),
            artifacts: subResults.flatMap((r) => r.artifacts),
          },
        };
        successes.push(merged);
        nodeResults.set(nodeId, merged);
      } else {
        const nr: NodeResult = { nodeId, status: "failed", error: subError ?? "unknown" };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      }
    }

    waveResults.push({ wave: wave.index, successes, failures });
  }

  return aggregateWaves(waveResults);
}

/** Execute a full DAG from scratch. */
export async function executeDAG(spec: DAGSpec, spawnFn: SpawnFn): Promise<DAGResult> {
  return executeDAGCore(spec, spawnFn);
}
