import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagExecuteTool } from "../src/dag/dag-execute-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// T1-4: DAG spawnFn diverged from spawn_role — it forwarded NO signal, set
// model: undefined (ignoring role.model), and parentSessionId: undefined. So a
// mid-DAG abort left already-spawned children running to completion (leaked
// slots + wasted work), and planner/reviewer's configured model was ignored.
// These tests prove the fix: tool signal → each child's spawn({signal}); role
// model resolved via ctx.modelRegistry; caller sessionFile passed as parentSessionId.

function role(name: string, over: Partial<RoleDef> = {}): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 10, canSpawn: false, teammates: [], ...over };
}

// Fake service that records each spawn's {signal, model, parentSessionId}.
function recordingService(spawns: any[]) {
  return {
    spawn: (p: any) => {
      spawns.push({ role: p.role, signal: p.signal, model: p.model, parentSessionId: p.parentSessionId });
      return p.role + "_id";
    },
    waitForResult: async (id: string) => ({ id, status: "completed", result: "ok", turnCount: 1, reportPayload: { findings: [id], artifacts: [] } }),
    getRecord: () => ({ status: "completed", turnCount: 1 } as any),
    getAbortController: () => ({ abort: () => {} }),
    abort: () => true,
  };
}

describe("dag_execute — T1-4: spawnFn forwards signal + model + parentSessionId", () => {
  it("the tool's AbortSignal is forwarded to each child's service.spawn({signal})", async () => {
    const spawns: any[] = [];
    const tool = makeDagExecuteTool({
      roleRegistry: new Map([["coder", role("coder")]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() },
      cwd: "/tmp", agentDir: "/tmp",
    });
    const ac = new AbortController();
    await tool.execute("tc1", {
      spec: { nodes: { a: { role: "coder", task: "[node:a] t" }, b: { role: "coder", task: "[node:b] t", depends_on: ["a"] } } },
    }, ac.signal, undefined, { sessionManager: { getSessionFile: () => "/tmp/caller.jsonl" } } as any);
    assert.equal(spawns.length, 2, "both nodes spawned");
    for (const s of spawns) {
      assert.equal(s.signal, ac.signal, `spawn for ${s.role} received the tool AbortSignal (was undefined before T1-4)`);
    }
  });

  it("role.model is resolved via ctx.modelRegistry and forwarded to service.spawn({model})", async () => {
    const spawns: any[] = [];
    const fakeModel = { id: "test-model", provider: "testprov" };
    // modelRegistry.find(provider, id) returns the model; getAll() fallback.
    const modelRegistry = { find: (provider: string, id: string) => (provider === "testprov" && id === "test-model" ? fakeModel : undefined), getAll: () => [fakeModel] };
    const tool = makeDagExecuteTool({
      roleRegistry: new Map([["reviewer", role("reviewer", { model: "testprov/test-model" })]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() },
      cwd: "/tmp", agentDir: "/tmp",
    });
    await tool.execute("tc1", {
      spec: { nodes: { r: { role: "reviewer", task: "[node:r] review" } } },
    }, undefined, undefined, { modelRegistry } as any);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].model, fakeModel, "role.model resolved via ctx.modelRegistry (was undefined before T1-4)");
  });

  it("caller sessionFile is passed as parentSessionId so DAG nodes join the tree-abort tree", async () => {
    const spawns: any[] = [];
    const tool = makeDagExecuteTool({
      roleRegistry: new Map([["coder", role("coder")]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() },
      cwd: "/tmp", agentDir: "/tmp",
    });
    await tool.execute("tc1", {
      spec: { nodes: { a: { role: "coder", task: "[node:a] t" } } },
    }, undefined, undefined, { sessionManager: { getSessionFile: () => "/tmp/caller.jsonl" } } as any);
    assert.equal(spawns[0].parentSessionId, "/tmp/caller.jsonl", "parentSessionId = caller sessionFile (was undefined before T1-4)");
  });
});
