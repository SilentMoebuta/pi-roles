// 端到端编排验证: 4 合同审查 role 的 DAG 结构 (wave0=法务‖财务‖业务并行 → wave1=chief-reviewer 依赖三者).
// 证明 dag_execute 能正确编排 4 视角框架 + upstream 注入. 真 LLM 产出需重启 pi 后
// (roleRegistry 加载 4 role) 用 dag_execute role-name 方式跑 — 见 e2e-4role-contract.spec.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { planWaves } from "../src/dag/planner";
import type { DAGSpec } from "../src/dag/types";

// 4 视角框架: 法务/财务/业务 并行 (wave 0) → 业财法综合 (wave 1, 依赖三者做冲突暴露).
const SPEC_4ROLE: DAGSpec = { nodes: {
  legal:    { role: "legal-counsel",      task: "[法务] 审合同法律风险 6 维" },
  finance:  { role: "financial-analyst",  task: "[财务] 审财务风险 5 维" },
  business: { role: "business-expert",    task: "[业务] 审业务可执行性 6 类" },
  chief:    { role: "chief-reviewer",     task: "[业财法综合] 4a 交叉风险/4b 视角冲突暴露/4c 遗漏补位 (不裁决)", depends_on: ["legal", "finance", "business"] },
}};

function fakeSpawn(): SpawnFn {
  return async (role, task) => ({
    agentId: task,
    wait: async () => ({
      status: "completed" as const,
      result: { findings: [`[${role}] done: ${task.slice(0, 30)}`], artifacts: [] },
    }),
  });
}

describe("4-role contract review DAG orchestration", () => {
  it("planner: 2 waves — wave0=3 parallel reviewers, wave1=chief-reviewer", () => {
    const waves = planWaves(SPEC_4ROLE);
    assert.equal(waves.length, 2);
    assert.equal(waves[0].nodes.length, 3, "wave 0: 法务/财务/业务 并行");
    const w0ids = waves[0].nodes.map(n => n.id).sort();
    assert.deepEqual(w0ids, ["business", "finance", "legal"]);
    assert.equal(waves[1].nodes.length, 1, "wave 1: chief-reviewer");
    assert.equal(waves[1].nodes[0].id, "chief");
  });

  it("executor: runs to completion, chief-reviewer receives 3 upstream results", async () => {
    const r = await executeDAG(SPEC_4ROLE, fakeSpawn());
    assert.equal(r.status, "completed");
    assert.equal(r.waves[0].successes.length, 3);
    assert.equal(r.waves[1].successes.length, 1);
    // all 4 nodes have finalContext entries (chief's includes synthesized from upstream)
    for (const id of ["legal", "finance", "business", "chief"]) {
      assert.ok(r.finalContext[id], `${id} has finalContext`);
    }
  });

  it("chief-reviewer's task gets upstreamResultsPrefix injected (3 predecessors)", async () => {
    let chiefTask = "";
    const spawnFn: SpawnFn = async (role, task) => {
      if (role === "chief-reviewer") chiefTask = task;
      return { agentId: role ?? "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    await executeDAG(SPEC_4ROLE, spawnFn);
    assert.match(chiefTask, /Upstream results/, "chief task contains upstream results prefix");
    assert.match(chiefTask, /legal/, "includes legal's result");
    assert.match(chiefTask, /finance/, "includes finance's result");
    assert.match(chiefTask, /business/, "includes business's result");
  });
});
