import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSkipReasonsFromResults } from "../src/dag/route-skip";
import type { DAGSpec, NodeResult } from "../src/dag/types";

describe("computeSkipReasonsFromResults", () => {
  const spec: DAGSpec = { nodes: {
    decide: { task: "t", routes: { accept: ["accept"], revise: ["revise"] } },
    accept: { task: "t", depends_on: ["decide"] },
    revise: { task: "t", depends_on: ["decide"] },
  }};
  it("skips unselected targets when router completed with a valid route", () => {
    const nr = new Map<string, NodeResult>([["decide", { nodeId: "decide", status: "completed", result: { findings: [], artifacts: [], route: "accept" } }]]);
    const skip = computeSkipReasonsFromResults(spec, nr);
    assert.ok(skip.has("revise"));
    assert.ok(!skip.has("accept"));
  });
  it("skips ALL targets when router failed", () => {
    const nr = new Map<string, NodeResult>([["decide", { nodeId: "decide", status: "failed", error: "missing route" }]]);
    const skip = computeSkipReasonsFromResults(spec, nr);
    assert.ok(skip.has("accept"));
    assert.ok(skip.has("revise"));
  });
  it("returns empty map when no routing node has run yet", () => {
    assert.equal(computeSkipReasonsFromResults(spec, new Map()).size, 0);
  });
  it("returns empty map for a DAG with no routes", () => {
    const noRoute: DAGSpec = { nodes: { a: { task: "t" }, b: { task: "t", depends_on: ["a"] } } };
    const nr: Map<string, NodeResult> = new Map([["a", { nodeId: "a", status: "completed", result: { findings: [], artifacts: [] } }]]);
    assert.equal(computeSkipReasonsFromResults(noRoute, nr).size, 0);
  });
});
