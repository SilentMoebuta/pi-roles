// Phase 5b DAG executor: topological waves, each wave spawns all nodes in
// parallel and barriers on Promise.allSettled. A failed node cannot abort its
// siblings (allSettled, not all). Downstream nodes whose predecessor failed
// receive an error-context prefix on their task (5d). Uses an injected spawnFn
// so it never touches AgentHandle and stays structuredClone-safe.
import type { DAGSpec, WaveResult, NodeResult, DAGResult } from "./types";
import { planWaves } from "./planner";
import { aggregateWaves, errorContextPrefix } from "./state";

export interface SpawnHandle {
  agentId: string;
  wait: () => Promise<{
    status: string;
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
    // PARALLEL: spawn all nodes in this wave (background).
    const handles = await Promise.all(
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

    // BARRIER: wait for ALL nodes (allSettled = partial-failure tolerant).
    const settled = await Promise.allSettled(handles.map(({ h }) => h.wait()));
    const successes: NodeResult[] = [];
    const failures: NodeResult[] = [];
    settled.forEach((res, i) => {
      const nodeId = handles[i].nodeId;
      if (res.status === "fulfilled") {
        const r = res.value;
        if (r.status === "completed") {
          const payload = r.reportPayload ?? r.result ?? { findings: [], artifacts: [] };
          const nr: NodeResult = { nodeId, status: "completed", result: payload };
          successes.push(nr);
          nodeResults.set(nodeId, nr);
        } else {
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
