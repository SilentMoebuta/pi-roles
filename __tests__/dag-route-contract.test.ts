import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRouteContract, withRouteField, withRouteTaskSuffix } from "../src/dag/route-contract";
import { DEFAULT_REPORT_SCHEMA } from "../src/contract";

// P1 (full): routes DAG auto-contract. A node declaring `routes` must be
// self-contained — the router role's report_role_result schema must advertise
// a `route` field and the task must tell the model which keys are valid.
// Otherwise the model never returns `route` and every routes DAG fails at the
// router (live-confirmed 2026-07-01: "missing route in node result").

describe("withRouteField", () => {
  it("adds route (string, required) to the default schema", () => {
    const s = withRouteField(undefined);
    assert.equal(s.properties.route?.type, "string");
    assert.ok(s.required.includes("route"), "route is required");
    // default fields preserved
    assert.ok(s.properties.findings && s.properties.artifacts);
  });

  it("merges route onto a custom schema without clobbering other fields", () => {
    const custom = {
      type: "object" as const,
      required: ["findings", "artifacts", "verdict"],
      properties: {
        findings: { type: "array" as const },
        artifacts: { type: "array" as const },
        verdict: { type: "string" as const },
      },
    };
    const s = withRouteField(custom);
    assert.equal(s.properties.verdict?.type, "string", "existing custom field preserved");
    assert.equal(s.properties.route?.type, "string", "route added");
    assert.ok(s.required.includes("verdict"), "existing required preserved");
    assert.ok(s.required.includes("route"), "route added to required");
  });

  it("is idempotent (route already present → unchanged)", () => {
    const withRoute = withRouteField(undefined);
    const again = withRouteField(withRoute);
    assert.deepEqual(again.required, withRoute.required);
    assert.deepEqual(Object.keys(again.properties).sort(), Object.keys(withRoute.properties).sort());
  });
});

describe("withRouteTaskSuffix", () => {
  it("appends a route contract listing every route key", () => {
    const t = withRouteTaskSuffix("decide quality", { accept: ["accept"], revise: ["revise"] });
    assert.match(t, /decide quality/);
    assert.match(t, /"accept"/);
    assert.match(t, /"revise"/);
    assert.match(t, /route/i);
  });
});

describe("resolveRouteContract", () => {
  it("no routes → base schema + unchanged task (no-op)", () => {
    const { schema, task } = resolveRouteContract({ outputSchema: undefined, task: "do work", routes: undefined });
    assert.deepEqual(schema, DEFAULT_REPORT_SCHEMA);
    assert.equal(task, "do work");
  });

  it("empty routes map → no-op (treat as no routes)", () => {
    const { schema, task } = resolveRouteContract({ task: "do work", routes: {} });
    assert.deepEqual(schema, DEFAULT_REPORT_SCHEMA);
    assert.equal(task, "do work");
  });

  it("routes present → schema has route (required) + task has suffix with keys", () => {
    const { schema, task } = resolveRouteContract({
      task: "gate decision",
      routes: { accept: ["accept"], revise: ["revise"] },
    });
    assert.equal(schema.properties.route?.type, "string");
    assert.ok(schema.required.includes("route"));
    assert.match(task, /gate decision/);
    assert.match(task, /"accept"/);
    assert.match(task, /"revise"/);
  });

  it("routes present + custom outputSchema → route merged onto custom schema", () => {
    const custom = {
      type: "object" as const,
      required: ["findings", "artifacts", "verdict"],
      properties: {
        findings: { type: "array" as const },
        artifacts: { type: "array" as const },
        verdict: { type: "string" as const },
      },
    };
    const { schema } = resolveRouteContract({ outputSchema: custom, task: "t", routes: { a: ["a"] } });
    assert.equal(schema.properties.verdict?.type, "string", "custom field preserved");
    assert.equal(schema.properties.route?.type, "string", "route added");
  });
});
