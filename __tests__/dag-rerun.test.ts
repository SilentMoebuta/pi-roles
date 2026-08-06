import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagRerunTool } from "../src/dag/dag-rerun-tool";
import { buildRerunView } from "../src/dag/rerun";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { makeCheckpointV2, serializeCheckpoint } from "../src/dag/checkpoint";
import type { DAGCheckpointV2 } from "../src/dag/checkpoint";
import type { DAGExecutionSnapshot } from "../src/dag/types";
import type { DAGSpec, NodeResult } from "../src/dag/types";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

function role(name: string, over: Partial<RoleDef> = {}): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 10, canSpawn: false, teammates: [], ...over };
}

function fakeSvc() {
  const spawned: any[] = [];
  let nextId = 0;
  return {
    spawned,
    svc: {
      spawn: (p: any) => { spawned.push(p); return `s${nextId++}`; },
      waitForResult: async (id: string) => ({ id, status: "completed", turnCount: 1, reportPayload: { findings: [`${id}-output`], artifacts: [`/${id}.ts`] } }),
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    },
  };
}

/** Build a V2 checkpoint from a fully executed spec (all nodes completed). */
function completedCheckpoint(spec: DAGSpec): { cp: DAGCheckpointV2; snapshot: DAGExecutionSnapshot } {
  const snapshot: DAGExecutionSnapshot = {
    scheduler: "ready",
    expandedSpec: spec,
    nodeStates: Object.fromEntries(Object.keys(spec.nodes).map((id) => [id, { status: "completed", startedAt: 1, finishedAt: 2 }])),
    nodeModes: Object.fromEntries(Object.keys(spec.nodes).map((id) => [id, "spawn" as const])),
    skipReasons: {},
    generatedNodes: {},
    dispatchExpansions: {},
    nodeResults: Object.fromEntries(Object.keys(spec.nodes).map((id) => [id, { nodeId: id, status: "completed", result: { findings: [`${id}-original`], artifacts: [`/${id}.ts`] } }])),
  };
  return { cp: makeCheckpointV2(spec, snapshot), snapshot };
}

const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };

describe("dag_rerun view derivation", () => {
  it("reruns the requested node AND its downstream closure, reusing untouched results", async () => {
    const { spawned, svc } = fakeSvc();
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder"));
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "task-a", depends_on: [] },
      b: { role: "coder", task: "task-b", depends_on: ["a"] },
      c: { role: "coder", task: "task-c", depends_on: ["b"] },
    } };
    const { cp } = completedCheckpoint(spec);

    const tool = makeDagRerunTool({ roleRegistry, service: svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const result: any = await tool.execute("tc", { checkpoint: serializeCheckpoint(cp), rerunNodes: ["b"] }, undefined, undefined, {} as any);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    const tasks = spawned.map((s: any) => s.task ?? "");
    // b and c rerun (c is downstream of b); a is reused, NOT re-spawned.
    assert.ok(tasks.some((t: string) => t.includes("task-b")), "b reran");
    assert.ok(tasks.some((t: string) => t.includes("task-c")), "c reran (downstream closure)");
    assert.ok(!tasks.some((t: string) => t.includes("task-a")), "a reused, not re-spawned");
    const closure = (result.details as any).rerunClosure as string[];
    assert.deepEqual([...closure].sort(), ["b", "c"]);
  });

  it("defaults to rerunning all failed nodes (FROM_FAILURE semantics)", () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "a" },
      b: { task: "b", depends_on: ["a"] },
      c: { task: "c", depends_on: ["b"] },
    } };
    const snapshot: DAGExecutionSnapshot = {
      scheduler: "ready",
      expandedSpec: spec,
      nodeStates: {
        a: { status: "completed", startedAt: 1, finishedAt: 2 },
        b: { status: "failed", error: "boom", startedAt: 1, finishedAt: 2 },
        c: { status: "queued" },
      },
      nodeModes: { a: "spawn", b: "spawn", c: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
      nodeResults: { a: { nodeId: "a", status: "completed", result: { findings: ["a-ok"], artifacts: ["/a.ts"] } } },
    };
    const cp = makeCheckpointV2(spec, snapshot);
    const view = buildRerunView(cp, {});
    assert.ok(!("errors" in view));
    assert.deepEqual([...view.rerunClosure].sort(), ["b", "c"], "failed node b + downstream c rerun; a reused");
    assert.equal(view.initialNodeResults.has("a"), true);
    assert.equal(view.initialNodeResults.has("b"), false);
    assert.equal(view.initialNodeStates.b.status, "queued");
  });

  it("injects failure feedback into rerun node tasks only", async () => {
    const { spawned, svc } = fakeSvc();
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder"));
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "task-a" },
      b: { role: "coder", task: "task-b", depends_on: ["a"] },
    } };
    const { cp } = completedCheckpoint(spec);
    const tool = makeDagRerunTool({ roleRegistry, service: svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const result: any = await tool.execute("tc", {
      checkpoint: serializeCheckpoint(cp),
      rerunNodes: ["b"],
      inject: { b: "verification failed: output must be lowercase" },
    }, undefined, undefined, {} as any);
    if (result.isError) console.log("INJECT-ERR:", result.content?.[0]?.text);
    assert.equal(result.isError, undefined);
    const tasks = spawned.map((s: any) => s.task ?? "");
    const bTask = tasks.find((t: string) => t.includes("task-b"));
    assert.ok(bTask.includes("RERUN-FEEDBACK"), "feedback injected into b");
    assert.ok(bTask.includes("verification failed"), "feedback text present");
  });

  it("applies specPatch: add, remove and modify with result reuse", async () => {
    const { spawned, svc } = fakeSvc();
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder"));
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "task-a" },
      b: { role: "coder", task: "task-b", depends_on: ["a"] },
    } };
    const { cp } = completedCheckpoint(spec);
    const tool = makeDagRerunTool({ roleRegistry, service: svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const result: any = await tool.execute("tc", {
      checkpoint: serializeCheckpoint(cp),
      specPatch: {
        remove: ["b"],
        modify: { a: { task: "task-a-v2" } },
        add: { d: { role: "coder", task: "task-d", depends_on: ["a"] } },
      },
    }, undefined, undefined, {} as any);
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    const tasks = spawned.map((s: any) => s.task ?? "");
    assert.ok(tasks.some((t: string) => t.includes("task-d")), "added node d ran");
    assert.ok(tasks.some((t: string) => t.includes("task-a-v2")), "modified node a reran with new task");
    assert.ok(!tasks.some((t: string) => t.includes("task-b")), "removed node b did not run");
  });

  it("rejects specPatch that breaks admission (unknown role)", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "task-a" } } };
    const { cp } = completedCheckpoint(spec);
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder"));
    const tool = makeDagRerunTool({ roleRegistry, service: fakeSvc().svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const result: any = await tool.execute("tc", {
      checkpoint: serializeCheckpoint(cp),
      specPatch: { add: { z: { role: "nonexistent-role", task: "z" } } },
    }, undefined, undefined, {} as any);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.details), /unknown role/);
  });

  it("rejects malformed rerun options and non-V2 checkpoints", async () => {
    const roleRegistry = new Map<string, RoleDef>();
    const tool = makeDagRerunTool({ roleRegistry, service: fakeSvc().svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const v1: any = await tool.execute("tc", { checkpoint: JSON.stringify({ spec: { nodes: { a: { task: "a" } } }, completedWaves: [] }) }, undefined, undefined, {} as any);
    assert.equal(v1.isError, true);
    assert.match(v1.content[0].text, /V2 checkpoint/);
    // specPatch.remove of an unknown node is a hard error
    const spec: DAGSpec = { nodes: { a: { task: "a" } } };
    const { cp } = completedCheckpoint(spec);
    const bad: any = await tool.execute("tc", { checkpoint: serializeCheckpoint(cp), specPatch: { remove: ["ghost"] } }, undefined, undefined, {} as any);
    assert.equal(bad.isError, true);
    assert.match(JSON.stringify(bad.details), /unknown node/);
  });
});
