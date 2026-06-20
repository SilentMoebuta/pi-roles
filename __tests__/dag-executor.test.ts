import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

// Fake spawnFn: completes after a tick. Configurable per-node outcome.
function fakeSpawn(outcomes: Record<string, { status: "completed" | "failed"; result?: { findings: string[]; artifacts: string[] }; error?: string }>): SpawnFn {
  return async (role: string, task: string) => {
    // derive nodeId from task marker "[node:<id>]" injected by test specs
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    const oc = outcomes[nodeId] ?? { status: "completed" as const, result: { findings: [task], artifacts: [] } };
    return {
      agentId: nodeId,
      wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }),
    };
  };
}

describe("dag executor (waves + barrier + partial failure)", () => {
  it("runs a 2-wave DAG to completion", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
      c: { role: "reviewer", task: "[node:c] review", depends_on: ["a", "b"] },
    }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "completed", result: { findings: ["fa"], artifacts: [] } }, b: { status: "completed", result: { findings: ["fb"], artifacts: [] } }, c: { status: "completed", result: { findings: ["fc"], artifacts: [] } } }));
    assert.equal(r.status, "completed");
    assert.equal(r.waves.length, 2);
    assert.equal(r.waves[0].successes.length, 2);
    assert.equal(r.waves[1].successes.length, 1);
  });

  it("partial failure: a failed node does NOT abort its sibling in the same wave", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
    }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "failed", error: "boom" }, b: { status: "completed", result: { findings: ["fb"], artifacts: [] } } }));
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1);
    assert.equal(r.waves[0].successes.length, 1, "sibling b still succeeded despite a failing");
  });

  it("downstream node receives error context when a predecessor failed", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b", depends_on: ["a"] },
    }};
    let seenTask = "";
    const spawnFn: SpawnFn = async (_role, task) => {
      if (task.includes("[node:b]")) seenTask = task;
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      const oc = nodeId === "a" ? { status: "failed" as const, error: "boom" } : { status: "completed" as const, result: { findings: [], artifacts: [] } };
      return { agentId: nodeId, wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }) };
    };
    await executeDAG(spec, spawnFn);
    assert.match(seenTask, /Predecessor 'a' failed/);
  });

  it("status='failed' when the only node fails", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] do a" } }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "failed", error: "x" } }));
    assert.equal(r.status, "failed");
  });
});
