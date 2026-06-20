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

export async function executeDAG(spec: DAGSpec, spawnFn: SpawnFn): Promise<DAGResult> {
  const waves = planWaves(spec);
  const waveResults: WaveResult[] = [];
  const nodeResults = new Map<string, NodeResult>();

  for (const wave of waves) {
    // PARALLEL spawn (allSettled — a rejecting spawnFn does NOT abort siblings).
    const spawned = await Promise.allSettled(
      wave.nodes.map(async (n) => {
        let task = n.task;
        const failedDeps = n.deps.filter((d) => nodeResults.get(d)?.status === "failed");
        for (const d of failedDeps) {
          task += errorContextPrefix(d, nodeResults.get(d)!.error ?? "unknown");
        }
        const h = await spawnFn(n.role, task);
        return { nodeId: n.id, h };
      }),
    );

    // Partition: rejected spawns → immediate failed NodeResult; fulfilled → wait.
    const successes: NodeResult[] = [];
    const failures: NodeResult[] = [];
    const toWait: { nodeId: string; h: SpawnHandle }[] = [];
    spawned.forEach((res, i) => {
      const nodeId = wave.nodes[i].id;
      if (res.status === "rejected") {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      } else {
        toWait.push({ nodeId, h: res.value.h });
      }
    });

    // BARRIER: wait for all spawned nodes (allSettled — a failing wait does NOT abort siblings).
    const settled = await Promise.allSettled(toWait.map(({ h }) => h.wait()));
    settled.forEach((res, i) => {
      const { nodeId } = toWait[i];
      if (res.status === "fulfilled") {
        const r = res.value;
        if (r.status === "completed") {
          const payload = r.reportPayload ?? r.result ?? { findings: [], artifacts: [] };
          const nr: NodeResult = { nodeId, status: "completed", result: payload };
          successes.push(nr);
          nodeResults.set(nodeId, nr);
        } else {
          // aborted | error | failed → failed NodeResult (non-completed wait outcomes are failures)
          const nr: NodeResult = { nodeId, status: "failed", error: r.error ?? r.status };
          failures.push(nr);
          nodeResults.set(nodeId, nr);
        }
      } else {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      }
    });

    waveResults.push({ wave: wave.index, successes, failures });
  }

  return aggregateWaves(waveResults);
}
