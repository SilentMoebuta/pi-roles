// TDD for optional `role` in DAG nodes (灰区: node 不强制绑定 role).
// When role is omitted/undefined, the executor still runs the node — the
// spawnFn receives undefined and buildSpawnFn falls back to default tools
// (already implemented in dag-execute-tool.ts:75-79). This test pins the
// planner + executor behavior with role-less nodes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { planWaves } from "../src/dag/planner";
import type { DAGSpec } from "../src/dag/types";

function fakeSpawn(): SpawnFn {
  return async (role, task) => ({
    agentId: task,
    wait: async () => ({
      status: "completed" as const,
      result: { findings: [`role=${role ?? "<none>"}, task=${task}`], artifacts: [] },
    }),
  });
}

describe("DAG with optional role (no forced role binding)", () => {
  it("planner accepts nodes with role omitted", () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "do a" },
      b: { task: "do b", depends_on: ["a"] },
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 2);
    assert.equal(waves[0].nodes[0].id, "a");
    assert.equal(waves[1].nodes[0].id, "b");
  });

  it("executor runs a role-less node to completion", async () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "[node:a] do a" },
    }};
    const r = await executeDAG(spec, fakeSpawn());
    assert.equal(r.status, "completed");
    assert.equal(r.waves[0].successes.length, 1);
  });

  it("mixed DAG: some nodes with role, some without", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "researcher", task: "[node:a] research" },
      b: { task: "[node:b] no role" },
      c: { role: "coder", task: "[node:c] code", depends_on: ["a", "b"] },
    }};
    const r = await executeDAG(spec, fakeSpawn());
    assert.equal(r.status, "completed");
    assert.equal(r.waves.length, 2);
    // wave 0 has a + b (parallel), wave 1 has c
    assert.equal(r.waves[0].successes.length, 2);
    assert.equal(r.waves[1].successes.length, 1);
  });

  it("role-less node's result flows to downstream node via finalContext", async () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "[node:a] produce" },
      b: { role: "coder", task: "[node:b] consume", depends_on: ["a"] },
    }};
    const r = await executeDAG(spec, fakeSpawn());
    assert.ok(r.finalContext["a"], "role-less node a has a finalContext entry");
    assert.ok(r.finalContext["b"], "node b has a finalContext entry");
  });

  it("spawnFn receives undefined role for role-less nodes", async () => {
    let observedRole: string | undefined = "sentinel";
    const spawnFn: SpawnFn = async (role, _task) => {
      observedRole = role;
      return { agentId: "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    const spec: DAGSpec = { nodes: { a: { task: "do" } } };
    await executeDAG(spec, spawnFn);
    assert.equal(observedRole, undefined, "role propagated as undefined, not empty string");
  });
});
