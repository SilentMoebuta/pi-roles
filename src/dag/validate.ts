// DAG spec pre-validation — prevents silent failures from bad depends_on refs
// or orphaned nodes that the planner would drop. Called before executeDAG.
import type { DAGSpec } from "./types";

export interface DAGValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a DAG spec before execution. Catches:
 *  - depends_on references to non-existent node IDs
 *  - orphaned nodes (no path from root, missing/invalid deps that prevent scheduling)
 *  Reports clear errors instead of silently dropping nodes. */
export function validateDAG(spec: DAGSpec): DAGValidation {
  const nodeIds = Object.keys(spec.nodes);
  const errors: string[] = [];

  // 1. Check all depends_on refs exist
  for (const [id, node] of Object.entries(spec.nodes)) {
    for (const dep of (node.depends_on ?? [])) {
      if (!spec.nodes[dep]) {
        errors.push(`node '${id}' depends_on '${dep}' which does not exist in spec.nodes`);
      }
    }
  }

  // 2. Check for circular deps (Kahn's algorithm would detect this; we do it eagerly
  //    for a clear error message before any execution).
  //    Build reverse graph: for each node, count distinct ancestors via DFS.
  //    If node appears in its own ancestor chain, it's circular.
  const ancestors = new Map<string, Set<string>>();
  function getAncestors(id: string, visited: Set<string>): Set<string> {
    if (ancestors.has(id)) return ancestors.get(id)!;
    if (visited.has(id)) {
      errors.push(`circular dependency detected involving '${id}'`);
      return new Set();
    }
    visited.add(id);
    const set = new Set<string>();
    for (const dep of (spec.nodes[id]?.depends_on ?? [])) {
      if (dep === id) {
        errors.push(`node '${id}' depends_on itself`);
        continue;
      }
      set.add(dep);
      for (const a of getAncestors(dep, visited)) set.add(a);
    }
    ancestors.set(id, set);
    return set;
  }
  for (const id of nodeIds) getAncestors(id, new Set());

  // 3. Check that all nodes are reachable from root (nodes with no deps).
  //    Unreachable nodes have unsatisfiable deps (e.g. dep on a node that was
  //    removed or renamed). The planner (Kahn) would never schedule them, but
  //    we report the error early so the caller knows which node is orphaned.
  const inQueue = new Set<string>();
  const queue = nodeIds.filter(id => (spec.nodes[id].depends_on ?? []).length === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    inQueue.add(id);
    for (const [nid, node] of Object.entries(spec.nodes)) {
      if (inQueue.has(nid)) continue;
      if ((node.depends_on ?? []).every(d => inQueue.has(d))) {
        queue.push(nid);
      }
    }
  }
  for (const id of nodeIds) {
    if (!inQueue.has(id) && !errors.some(e => e.includes(id))) {
      const deps = (spec.nodes[id].depends_on ?? []).join(', ');
      errors.push(`node '${id}' is unreachable (deps [${deps}] cannot all be satisfied — missing node or circular)`);
    }
  }

  return { ok: errors.length === 0, errors };
}
