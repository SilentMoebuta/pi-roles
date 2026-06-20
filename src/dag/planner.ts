// Topological sort into waves. A node enters the wave after ALL its deps.
// Kahn's algorithm, level by level. Throws on unknown dep or cycle.
import type { DAGSpec } from "./types";

export interface PlannedNode {
  id: string;
  role: string;
  task: string;
  deps: string[];
}

export interface Wave {
  index: number;
  nodes: PlannedNode[];
}

export function planWaves(spec: DAGSpec): Wave[] {
  const ids = Object.keys(spec.nodes);
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    const deps = spec.nodes[id].depends_on ?? [];
    for (const d of deps) {
      if (!indeg.has(d)) throw new Error(`DAG node '${id}' depends on unknown node '${d}'`);
    }
    indeg.set(id, deps.length);
    for (const d of deps) dependents.get(d)!.push(id);
  }

  const waves: Wave[] = [];
  const remaining = new Set(ids);
  let waveIndex = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (indeg.get(id) ?? 0) === 0);
    if (ready.length === 0) throw new Error("DAG has a cycle");
    waves.push({
      index: waveIndex++,
      nodes: ready.map((id) => {
        const n = spec.nodes[id];
        return { id, role: n.role, task: n.task, deps: n.depends_on ?? [] };
      }),
    });
    for (const id of ready) {
      remaining.delete(id);
      for (const dep of dependents.get(id)!) {
        indeg.set(dep, (indeg.get(dep) ?? 1) - 1);
      }
    }
  }
  return waves;
}
