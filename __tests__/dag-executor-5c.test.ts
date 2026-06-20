import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";
import type { Send } from "../src/dag/send";

// 5c integration: a dynamic node (returning Send[]) fans out N parallel
// spawns within its wave, mixed with static nodes in the same DAG. The
// dynamic node's multiple results are merged into one NodeResult.

function handle(id: string, finding: string): { agentId: string; wait: () => Promise<any> } {
  return { agentId: id, wait: async () => ({ status: "completed", reportPayload: { findings: [finding], artifacts: [`/${id}.ts`] } }) };
}

describe("dag executor 5c — dynamic Send fan-out integrated with static nodes", () => {
  it("a dynamic node fans out 3 parallel coders in one wave; results merged", async () => {
    const spec: DAGSpec = { nodes: {
      plan: {
        role: "planner",
        task: "[node:plan] decompose",
        dynamic: async () => [
          { role: "coder", arg: "[node:plan] sub-A" },
          { role: "coder", arg: "[node:plan] sub-B" },
          { role: "coder", arg: "[node:plan] sub-C" },
        ],
      },
    }};
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (role, task) => {
      spawned.push(task);
      return handle(task, `done-${task.slice(-5)}`);
    };
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "completed");
    assert.equal(spawned.length, 3, "3 parallel spawns from the dynamic node");
    // merged result: 3 findings + 3 artifacts aggregated under nodeId 'plan'
    const planResult = r.finalContext.plan;
    assert.equal(planResult.findings.length, 3);
    assert.equal(planResult.artifacts.length, 3);
  });

  it("mixes static + dynamic nodes in the same wave (both run in parallel)", async () => {
    const spec: DAGSpec = { nodes: {
      static1: { role: "coder", task: "[node:static1] fixed task" },
      dyn: {
        role: "planner",
        task: "[node:dyn] decompose",
        dynamic: async () => [
          { role: "coder", arg: "[node:dyn] d1" },
          { role: "coder", arg: "[node:dyn] d2" },
        ],
      },
    }};
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (role, task) => { spawned.push(task); return handle(task, `ok-${task}`); };
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "completed");
    // static1 = 1 spawn, dyn = 2 spawns → 3 total in wave 0
    assert.equal(spawned.length, 3);
    assert.ok(r.finalContext.static1, "static node result present");
    assert.equal(r.finalContext.dyn.findings.length, 2, "dynamic node merged 2 results");
  });

  it("dynamic node with dependencies receives upstream results in context", async () => {
    let seenDeps: Record<string, unknown> | undefined;
    const spec: DAGSpec = { nodes: {
      prep: { role: "coder", task: "[node:prep] prepare" },
      fanout: {
        role: "planner",
        task: "[node:fanout] decompose",
        depends_on: ["prep"],
        dynamic: async (ctx) => {
          seenDeps = ctx.dependencies;
          return [{ role: "coder", arg: "[node:fanout] worker-1" }];
        },
      },
    }};
    const spawnFn: SpawnFn = async (_r, task) => handle(task, `x-${task}`);
    await executeDAG(spec, spawnFn);
    assert.ok(seenDeps, "dynamic node received a dependencies context");
    assert.ok((seenDeps as any)?.prep, "upstream 'prep' result was passed in");
  });
});
