import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planWaves } from "../src/dag/planner";
import type { DAGSpec } from "../src/dag/types";

describe("dag planner (topological waves)", () => {
  it("single wave when no deps", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "t1" },
      b: { role: "coder", task: "t2" },
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].nodes.length, 2);
  });

  it("chains dependents into later waves", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "t1" },
      b: { role: "coder", task: "t2", depends_on: ["a"] },
      c: { role: "coder", task: "t3", depends_on: ["b"] },
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0].nodes.map(n => n.id), ["a"]);
    assert.deepEqual(waves[1].nodes.map(n => n.id), ["b"]);
    assert.deepEqual(waves[2].nodes.map(n => n.id), ["c"]);
  });

  it("fan-in: node with multiple predecessors runs only after all", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "t1" },
      b: { role: "coder", task: "t2" },
      c: { role: "reviewer", task: "review", depends_on: ["a", "b"] },
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 2);
    assert.equal(waves[0].nodes.length, 2);
    assert.deepEqual(waves[1].nodes.map(n => n.id), ["c"]);
  });

  it("throws on unknown dependency", () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "t", depends_on: ["ghost"] } }};
    assert.throws(() => planWaves(spec), /unknown node 'ghost'/);
  });

  it("throws on a cycle", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "t", depends_on: ["b"] },
      b: { role: "coder", task: "t", depends_on: ["a"] },
    }};
    assert.throws(() => planWaves(spec), /cycle/);
  });
});
