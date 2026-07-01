// P1 (full): routes DAG auto-contract.
//
// A node declaring `routes` is a self-contained contract: the router role MUST
// return a `route` field selecting one downstream branch. Without this helper,
// the router's report_role_result schema only exposes {findings, artifacts}
// (DEFAULT_REPORT_SCHEMA), so the model never returns `route` and every routes
// DAG fails at the router with "missing route in node result" (live-confirmed
// 2026-07-01).
//
// resolveRouteContract merges `route` (string, required) into the role's report
// schema and appends a route-contract suffix to the task naming the valid keys.
// Both inline roleDef and registry roles are handled uniformly — the caller
// declares `routes` and the contract wires itself.
//
// ponytail: pure functions so the contract is unit-testable without spawning.

import { DEFAULT_REPORT_SCHEMA, type ReportSchema } from "../contract";

/** Merge a `route` (string, required) field onto a report schema. Idempotent. */
export function withRouteField(schema?: ReportSchema): ReportSchema {
  const base = schema ?? DEFAULT_REPORT_SCHEMA;
  if (base.properties.route) return base;
  return {
    type: "object",
    required: base.required.includes("route") ? base.required : [...base.required, "route"],
    properties: { ...base.properties, route: { type: "string" } },
  };
}

/** Append a route contract to the task text, naming every valid route key. */
export function withRouteTaskSuffix(task: string, routes: Record<string, string[]>): string {
  const keys = Object.keys(routes);
  const list = keys.map((k) => `"${k}"`).join(", ");
  return `${task}\n\n[route contract] This node declares conditional routes. You MUST include a top-level "route" field in your report_role_result arguments, set to exactly one of: ${list}. The route field is required and selects which downstream branch runs.`;
}

/**
 * Effective report schema + task for a node. When `routes` is absent/empty this
 * is a no-op (base schema + unchanged task). When present, `route` is merged
 * onto the schema and the route contract is appended to the task.
 */
export function resolveRouteContract(opts: {
  outputSchema?: ReportSchema;
  task: string;
  routes?: Record<string, string[]>;
}): { schema: ReportSchema; task: string } {
  if (!opts.routes || Object.keys(opts.routes).length === 0) {
    return { schema: opts.outputSchema ?? DEFAULT_REPORT_SCHEMA, task: opts.task };
  }
  return {
    schema: withRouteField(opts.outputSchema),
    task: withRouteTaskSuffix(opts.task, opts.routes),
  };
}
