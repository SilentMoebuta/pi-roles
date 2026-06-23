// TDD for dag_execute node.model + node.thinkingLevel per-node override.
// 调用方指定模型/思考强度 (服务化时 pi -p --model X 透传给所有子节点).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { planWaves } from "../src/dag/planner";
import type { DAGSpec } from "../src/dag/types";

describe("DAG node.model + node.thinkingLevel per-node override", () => {
  it("planner accepts nodes with model + thinkingLevel", () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "审法务", model: "deepseek/deepseek-v4-flash", thinkingLevel: "high" } as any,
    }};
    const waves = planWaves(spec);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].nodes[0].id, "a");
  });

  it("spawnFn receives model + thinkingLevel as 4th/5th args", async () => {
    let observed: { model?: string; thinkingLevel?: string } = {};
    const spawnFn: SpawnFn = async (_role, _task, _roleDef, model?, thinkingLevel?) => {
      observed = { model, thinkingLevel };
      return { agentId: "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "审法务", model: "deepseek/deepseek-v4-flash", thinkingLevel: "high" } as any,
    }};
    await executeDAG(spec, spawnFn);
    assert.equal(observed.model, "deepseek/deepseek-v4-flash");
    assert.equal(observed.thinkingLevel, "high");
  });

  it("node.model overrides role.frontmatter model (per-node wins)", async () => {
    // 即使 role 定义里有 model, node.model 应优先. 这里用 inline roleDef 带 model 验证冲突解决.
    let observedRoleModel: string | undefined;
    let observedNodeModel: string | undefined;
    const spawnFn: SpawnFn = async (_role, _task, roleDef, model?) => {
      observedRoleModel = roleDef?.model;        // roleDef 自带的 model
      observedNodeModel = model;                  // node 级覆盖的 model (应优先)
      return { agentId: "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    const spec: DAGSpec = { nodes: {
      a: {
        roleDef: { name: "x", description: "d", prompt: "p", tools: ["read"], model: "ksyun/glm-5.2" },
        task: "t",
        model: "deepseek/deepseek-v4-flash",  // node 级覆盖, 应优先于 roleDef.model
      } as any,
    }};
    await executeDAG(spec, spawnFn);
    assert.equal(observedNodeModel, "deepseek/deepseek-v4-flash", "node.model wins");
    assert.equal(observedRoleModel, "ksyun/glm-5.2", "roleDef.model still readable but node wins");
  });

  it("thinkingLevel omitted → spawnFn receives undefined (inherits role/default)", async () => {
    let observedThinking: string | undefined = "sentinel";
    const spawnFn: SpawnFn = async (_role, _task, _roleDef, _model, thinkingLevel?) => {
      observedThinking = thinkingLevel;
      return { agentId: "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t" } as any,  // 无 thinkingLevel
    }};
    await executeDAG(spec, spawnFn);
    assert.equal(observedThinking, undefined, "thinkingLevel undefined when not set on node");
  });

  it("mixed: some nodes override model, some inherit", async () => {
    const observed: Record<string, { model?: string; thinkingLevel?: string }> = {};
    const spawnFn: SpawnFn = async (role, _task, _roleDef, model?, thinkingLevel?) => {
      observed[role ?? "default"] = { model, thinkingLevel };
      return { agentId: role ?? "x", wait: async () => ({ status: "completed" as const, result: { findings: [], artifacts: [] } }) };
    };
    const spec: DAGSpec = { nodes: {
      a: { role: "legal-counsel", task: "t", model: "deepseek/deepseek-v4-flash", thinkingLevel: "high" } as any,
      b: { role: "financial-analyst", task: "t" } as any,  // 继承
      c: { role: "business-expert", task: "t", thinkingLevel: "off" } as any,  // 关思考
    }};
    await executeDAG(spec, spawnFn);
    assert.equal(observed["legal-counsel"].model, "deepseek/deepseek-v4-flash");
    assert.equal(observed["legal-counsel"].thinkingLevel, "high");
    assert.equal(observed["financial-analyst"].model, undefined, "inherits when node.model omitted");
    assert.equal(observed["business-expert"].thinkingLevel, "off", "off allowed (关闭思考)");
  });
});
