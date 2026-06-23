// Topological sort into waves. A node enters the wave after ALL its deps.
// Kahn's algorithm, level by level. Throws on unknown dep or cycle.
import type { DAGSpec } from "./types";
import type { InlineRoleDef } from "../subagent/spawn-role-tool";

export interface PlannedNode {
  id: string;
  role?: string;
  /** Inline role definition carried from DAGNode.roleDef (ad-hoc experts). */
  roleDef?: InlineRoleDef;
  task: string;
  deps: string[];
  /** Phase 5c: carried from DAGNode.dynamic so the executor can fan out. */
  dynamic?: import("./send").DynamicNode;
  /** SOTA gap #3: carried from DAGNode.sends (serializable fan-out). */
  sends?: import("./send").Send[];
  /** SOTA gap #1: carried from DAGNode.timeout_ms for per-node timeout. */
  timeout_ms?: number;
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
        return { id, role: n.role, roleDef: n.roleDef, task: n.task, deps: n.depends_on ?? [], dynamic: n.dynamic, sends: n.sends, timeout_ms: n.timeout_ms };
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
