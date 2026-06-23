// TDD for inline roleDef in DAG nodes (cce V4-style dynamic experts).
// node.roleDef is mutually exclusive with node.role. SpawnFn receives roleDef
// as a 3rd arg; buildSpawnFn (dag-execute-tool.ts) routes roleDef to the inline
// path (buildInlineRole), role to registry, omit to default.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { planWaves } from "../src/dag/planner";
import type { DAGSpec } from "../src/dag/types";
import type { InlineRoleDef } from "../src/subagent/spawn-role-tool";

function fakeSpawnObserve(): { fn: SpawnFn; calls: { role?: string; roleDef?: InlineRoleDef; task: string }[] } {
  const calls: { role?: string; roleDef?: InlineRoleDef; task: string }[] = [];
  return {
    calls,
    fn: async (role, task, roleDef) => {
      calls.push({ role: role, roleDef, task });
      return { agentId: task, wait: async () => ({ status: "completed" as const, result: { findings: [`role=${role ?? "<inline>"}`], artifacts: [] } }) };
    },
  };
}

describe("DAG with inline roleDef nodes", () => {
  const ipExpert: InlineRoleDef = {
    name: "ip-expert", description: "临时IP专家", prompt: "你是IP专家", tools: ["read", "bash", "grep"],
  };

  it("planner accepts nodes with roleDef", () => {
    const spec: DAGSpec = { nodes: {
      a: { roleDef: ipExpert, task: "审IP" } as any,
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].nodes[0].id, "a");
  });

  it("executor runs a roleDef node to completion", async () => {
    const spec: DAGSpec = { nodes: {
      a: { roleDef: ipExpert, task: "[node:a] 审IP" } as any,
    }};
    const r = await executeDAG(spec, fakeSpawnObserve().fn);
    assert.equal(r.status, "completed");
    assert.equal(r.waves[0].successes.length, 1);
  });

  it("spawnFn receives roleDef as 3rd arg for roleDef nodes", async () => {
    const obs = fakeSpawnObserve();
    const spec: DAGSpec = { nodes: {
      a: { roleDef: ipExpert, task: "[node:a] 审IP" } as any,
    }};
    await executeDAG(spec, obs.fn);
    assert.equal(obs.calls.length, 1);
    assert.equal(obs.calls[0].role, undefined, "role is undefined for roleDef nodes");
    assert.deepEqual(obs.calls[0].roleDef, ipExpert, "roleDef propagated to spawnFn");
  });

  it("mixed DAG: roleDef nodes + role nodes + role-less nodes", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "researcher", task: "[node:a] research" },
      b: { roleDef: ipExpert, task: "[node:b] 审IP" } as any,
      c: { task: "[node:c] no role" },
      d: { role: "coder", task: "[node:d] code", depends_on: ["a", "b", "c"] },
    }};
    const r = await executeDAG(spec, fakeSpawnObserve().fn);
    assert.equal(r.status, "completed");
    assert.equal(r.waves[0].successes.length, 3, "wave 0: a + b + c parallel");
    assert.equal(r.waves[1].successes.length, 1, "wave 1: d");
  });

  it("roleDef node's result flows to downstream node via finalContext + upstreamResultsPrefix", async () => {
    const spec: DAGSpec = { nodes: {
      a: { roleDef: ipExpert, task: "[node:a] produce" } as any,
      b: { role: "coder", task: "[node:b] consume", depends_on: ["a"] },
    }};
    const r = await executeDAG(spec, fakeSpawnObserve().fn);
    assert.ok(r.finalContext["a"], "roleDef node a has a finalContext entry");
    assert.ok(r.finalContext["b"], "node b has a finalContext entry (received a's result)");
  });
});
