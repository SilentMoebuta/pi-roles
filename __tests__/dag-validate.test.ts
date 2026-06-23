// TDD for DAG spec pre-validation (P0 stability: prevent silent node drops).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDAG } from "../src/dag/validate";
import type { DAGSpec } from "../src/dag/types";
import type { InlineRoleDef } from "../src/subagent/spawn-role-tool";

const ipExpert: InlineRoleDef = { name: "ip", description: "d", prompt: "p", tools: ["read"] };

describe("validateDAG — pre-flight DAG spec validation", () => {
  it("valid DAG → ok=true, no errors", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t" },
      b: { role: "financial-analyst", task: "t" },
      c: { role: "chief-reviewer", task: "t", depends_on: ["a", "b"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, true);
    assert.deepEqual(v.errors, []);
  });

  it("depends_on unknown node → error", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t" },
      c: { role: "chief-reviewer", task: "t", depends_on: ["a", "non-existent"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /depends_on.*non-existent.*does not exist/i);
  });

  it("self-dependency → error", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t", depends_on: ["a"] },
    }};
    const v = validateDAG(spec);
    v.errors.forEach(e => console.log("self-dep error:", e));
    // may be reported as circular or self-dep
    assert.equal(v.ok, false, "self-dependency should be invalid");
    assert.ok(v.errors.some(e => /depends_on itself|circular/i.test(e)), "should report self-dep or circular");
  });

  it("circular dependency (a→b→a) → error", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t", depends_on: ["b"] },
      b: { role: "financial-analyst", task: "t", depends_on: ["a"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /circular/i.test(e)), "should report circular dependency");
  });

  it("unreachable node (depends on self indirectly via chain) → error", () => {
    // a→b→c→a is circular; all 3 should be flagged
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t", depends_on: ["b"] },
      b: { role: "financial-analyst", task: "t", depends_on: ["c"] },
      c: { role: "business-expert", task: "t", depends_on: ["a"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some(e => /circular/i.test(e)));
  });

  it("roleDef nodes validated same as role nodes (mixed DAG)", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t" },
      b: { roleDef: ipExpert, task: "t" } as any,
      c: { role: "chief-reviewer", task: "t", depends_on: ["a", "b", "ghost"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, false);
    assert.match(v.errors[0], /depends_on.*ghost.*does not exist/i);
  });

  it("all errors reported (multiple bad refs)", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t", depends_on: ["x"] },
      b: { role: "financial-analyst", task: "t", depends_on: ["y"] },
    }};
    const v = validateDAG(spec);
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 2, `should report at least 2 errors, got ${v.errors.length}: ${v.errors}`);
  });
});
