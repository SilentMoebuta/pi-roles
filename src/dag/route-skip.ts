import type { DAGSpec, NodeResult } from "./types";

/**
 * Recompute route skipReasons from known node results (used on resume).
 * Mirrors executor's inline route→skip semantics:
 * - completed + valid route → skip unselected targets
 * - failed / missing / unknown route → skip all targets
 * - routing node not yet run → no skips derived from it
 *
 * ponytail: a status:'failed' router is forced to "skip all targets" here.
 * The executor distinguishes two failure origins — (a) completed-but-bad-route
 * (missing/unknown) which skips all, vs (b) a crashed/wait-errored router whose
 * targets the executor would actually RUN with error context. Both surface as
 * status:'failed' in a checkpoint (only the `error` string differs, a fragile
 * discriminator), so the pure fn cannot tell them apart and applies the clean
 * Airflow-consistent "skip all" rule. This is the ceiling of what recompute can
 * do without richer persisted state; acceptable because it is conservative
 * (never wrongly runs a branch) and out of scope for the unselected-branch goal.
 */
export function computeSkipReasonsFromResults(
  spec: DAGSpec,
  nodeResults: Map<string, NodeResult>,
): Map<string, string> {
  const skipReasons = new Map<string, string>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (!node.routes) continue;
    const nr = nodeResults.get(id);
    if (!nr) continue;
    const allTargets = new Set(Object.values(node.routes).flat());
    const route = nr.status === "completed" ? nr.result?.route : undefined;
    const selected = typeof route === "string" && route.length > 0 ? node.routes[route] : undefined;
    if (selected) {
      const selectedSet = new Set(selected);
      for (const t of allTargets) {
        if (!selectedSet.has(t)) skipReasons.set(t, `route '${route}' from '${id}' did not select '${t}'`);
      }
    } else {
      for (const t of allTargets) skipReasons.set(t, `routing node '${id}' did not produce a valid route`);
    }
  }
  return skipReasons;
}
