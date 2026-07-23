import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnRoleTool, type SpawnToolDeps } from "../src/subagent/spawn-role-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// Provider-abort steering-queue workaround: agent-loop.js returns early on
// stopReason='aborted' without draining the steering queue, so the
// output-contract enforcer's agent_end reminder never runs. On retry we inject
// the reminder as a task prefix so the child knows to re-do the work AND call
// report_role_result. Scoped to provider-abort only (step-limit gets the plain
// task - a "模型服务中断" message there would be misleading).

function role(name: string): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 25, canSpawn: false, teammates: [] };
}

function depsFactory() {
  return (reason: string): { deps: SpawnToolDeps; spawnCalls: any[] } => {
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const spawnCalls: any[] = [];
    let spawnCount = 0;
    const d: SpawnToolDeps = {
      roleRegistry: new Map([["coder", role("coder")]]),
      service: {
        spawn: (p: any) => { spawnCalls.push(p); spawnCount++; return `id${spawnCount}`; },
        waitForResult: async (id: string) => {
          return spawnCount === 1
            ? { id, status: "aborted", reason, turnCount: 1 } as any
            : { id, status: "completed", result: "done", turnCount: 1, reportPayload: { findings: ["f"], artifacts: [] } } as any;
        },
        getRecord: () => ({ id: "id2", status: "completed", turnCount: 1 } as any),
        abort: () => true,
        getAbortController: () => ({ abort: () => {} }),
      },
      reportState,
      getCallerParentSession: () => undefined,
      getCallerSessionFile: () => undefined,
      now: () => 1000,
      notifyParent: undefined,
    };
    return { deps: d, spawnCalls };
  };
}

describe("spawn_role - provider-abort retry injects reminder task prefix (steering-queue workaround)", () => {
  it("provider-abort retry: attempt 2 task prefixed with the reminder", async () => {
    const { deps, spawnCalls } = depsFactory()("provider-abort");
    const tool = makeSpawnRoleTool(deps);
    await tool.execute("tc1", { role: "coder", task: "do the thing", retryCount: 1 }, undefined, undefined, {} as any);
    assert.equal(spawnCalls.length, 2, "aborted -> retried once");
    assert.equal(spawnCalls[0].task, "do the thing", "attempt 1 uses the original task");
    assert.ok(spawnCalls[1].task.includes("report_role_result"), `retry task must mention report_role_result, got: ${spawnCalls[1].task}`);
    assert.ok(spawnCalls[1].task.includes("模型服务中断"), `retry task must mention provider outage, got: ${spawnCalls[1].task}`);
    assert.ok(spawnCalls[1].task.endsWith("do the thing"), "retry task keeps the original task as suffix");
  });

  it("non-provider abort (step-limit) retry: no reminder prefix", async () => {
    const { deps, spawnCalls } = depsFactory()("step-limit");
    const tool = makeSpawnRoleTool(deps);
    await tool.execute("tc1", { role: "coder", task: "do the thing", retryCount: 1 }, undefined, undefined, {} as any);
    assert.equal(spawnCalls.length, 2, "aborted -> retried once");
    assert.equal(spawnCalls[0].task, "do the thing");
    assert.equal(spawnCalls[1].task, "do the thing", "step-limit retry gets the plain task (reminder is provider-abort-scoped)");
  });
});
