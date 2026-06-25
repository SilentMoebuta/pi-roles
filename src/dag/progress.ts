import type { DAGSpec } from "./types";

export type NodeStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface DagProgressView {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  nodes: Record<string, {
    task: string;
    deps: string[];
    status: NodeStatus;
    wave: number;
    error?: string;
  }>;
}

// Kahn's algorithm — topological layering. Mirrors planWaves() in executor.ts
// but reproduced here so the view is self-contained (pure, no executor dep).
function computeWaves(spec: DAGSpec): Record<string, number> {
  const wave: Record<string, number> = {};
  const remaining = new Map<string, string[]>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    wave[id] = 0;
    remaining.set(id, [...(node.depends_on ?? [])]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of remaining) {
      if (deps.length === 0) continue;
      if (deps.every(d => wave[d] >= 0 && remaining.get(d)!.length === 0)) {
        const maxDepWave = Math.max(...deps.map(d => wave[d] ?? 0), -1);
        wave[id] = maxDepWave + 1;
        remaining.set(id, []);
        changed = true;
      }
    }
  }
  return wave;
}

export function toDagProgress(
  spec: DAGSpec,
  raw: { currentWave: number; totalWaves: number; nodes?: Record<string, { status: string; error?: string }> },
  dagId = "",
): DagProgressView {
  const waves = computeWaves(spec);
  const nodes: DagProgressView["nodes"] = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const r = raw.nodes?.[id];
    nodes[id] = {
      task: node.task,
      deps: node.depends_on ?? [],
      status: (r?.status as NodeStatus) ?? "queued",
      wave: waves[id],
      error: r?.error,
    };
  }
  return { dagId, currentWave: raw.currentWave, totalWaves: raw.totalWaves, nodes };
}

// Bridge: wrap raw executor progress into the structured onUpdate payload.
// Fixes the regression where details was set to `undefined` (dag-execute-tool.ts),
// dropping the structured progress before it could reach tool_execution_update.
export function makeOnProgress(
  spec: DAGSpec,
  onUpdate: (r: { content: any[]; details: any }) => void,
  dagId = "",
) {
  return (p: { currentWave: number; totalWaves: number; nodes?: Record<string, { status: string; error?: string }> }) => {
    const view = toDagProgress(spec, p, dagId);
    onUpdate({
      content: [{ type: "text" as const, text: `DAG wave ${p.currentWave + 1}/${p.totalWaves} running…` }],
      details: { kind: "dag-progress" as const, spec, progress: view },
    });
  };
}
