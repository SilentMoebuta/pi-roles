import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnRoleTool, type SpawnToolDeps } from "../src/subagent/spawn-role-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// Provider-abort auto-retry: when the upstream provider aborts mid-generation
// (connection reset on long responses), the runner now detects it and marks the
// outcome as aborted reason "provider-abort". spawn_role defaults retryCount=1
// so this transient failure auto-retries once instead of returning an empty
// result that hangs the parent (the CCE final-reviewer hang root cause).

function role(name: string): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 25, canSpawn: false, teammates: [] };
}

describe("spawn_role - provider-abort auto-retry (default retryCount=1)", () => {
  it("provider-abort on attempt 1 -> auto-retries (default retryCount=1) -> attempt 2 succeeds", async () => {
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const spawnCalls: any[] = [];
    let spawnCount = 0;
    const d: SpawnToolDeps = {
      roleRegistry: new Map([["reviewer", role("reviewer")]]),
      service: {
        spawn: (p: any) => { spawnCalls.push(p); spawnCount++; return `id${spawnCount}`; },
        waitForResult: async (id: string) => {
          return spawnCount === 1
            ? { id, status: "aborted", reason: "provider-abort", turnCount: 1 } as any
            : { id, status: "completed", result: "verdict", turnCount: 3, reportPayload: { findings: ["APPROVED"], artifacts: [] } } as any;
        },
        getRecord: () => ({ id: "id2", status: "completed", turnCount: 3 } as any),
        abort: () => true,
        getAbortController: () => ({ abort: () => {} }),
      },
      reportState,
      getCallerParentSession: () => undefined,
      getCallerSessionFile: () => undefined,
      now: () => 1000,
      notifyParent: undefined,
    };
    const tool = makeSpawnRoleTool(d);
    const result: any = await tool.execute("tc1", { role: "reviewer", task: "review X" }, undefined, undefined, {} as any);
    const parsed = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(spawnCalls.length, 2, "provider-abort -> auto-retried once by default (retryCount defaults to 1)");
    assert.equal(parsed.status, "completed");
    assert.deepEqual(parsed.result?.findings, ["APPROVED"]);
  });

  it("explicit retryCount=0 disables auto-retry even on provider-abort", async () => {
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    let spawnCount = 0;
    const d: SpawnToolDeps = {
      roleRegistry: new Map([["reviewer", role("reviewer")]]),
      service: {
        spawn: () => { spawnCount++; return `id${spawnCount}`; },
        waitForResult: async (id: string) => {
          return { id, status: "aborted", reason: "provider-abort", turnCount: 1 } as any;
        },
        getRecord: () => ({ id: "id1", status: "aborted", turnCount: 1 } as any),
        abort: () => true,
        getAbortController: () => ({ abort: () => {} }),
      },
      reportState,
      getCallerParentSession: () => undefined,
      getCallerSessionFile: () => undefined,
      now: () => 1000,
      notifyParent: undefined,
    };
    const tool = makeSpawnRoleTool(d);
    const result: any = await tool.execute("tc1", { role: "reviewer", task: "review X", retryCount: 0 }, undefined, undefined, {} as any);
    const parsed = JSON.parse(result.content?.[0]?.text ?? "{}");
    assert.equal(spawnCount, 1, "retryCount=0 disables auto-retry even on provider-abort");
    assert.equal(parsed.status, "aborted");
    assert.ok(parsed.error.includes("provider-abort"), `error should mention provider-abort, got: ${parsed.error}`);
  });
});
