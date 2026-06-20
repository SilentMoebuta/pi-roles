import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnRoleTool, type SpawnToolDeps } from "../src/subagent/spawn-role-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// T3-7: retry loop reused the outer-scope childReportTool (shared childReportState)
// across attempts. On a degenerate session key ('default' fallback — no
// sessionManager), attempt 1's reported.add('default') made attempt 2's
// report_role_result hit duplicate_report. The fix reconstructs childReportTool +
// childReportState per attempt. This test verifies the customTools passed to each
// spawn are DISTINCT tool instances (the retry built a fresh one, not reused).

function role(name: string): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 25, canSpawn: false, teammates: [] };
}

describe("spawn_role — retry reconstructs ReportState per attempt (T3-7)", () => {
  it("attempt 2's customTools carry a FRESH report tool (distinct instance from attempt 1)", async () => {
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const spawnCalls: any[] = [];
    let spawnCount = 0;
    const d: SpawnToolDeps = {
      roleRegistry: new Map([["coder", role("coder")]]),
      service: {
        spawn: (p: any) => { spawnCalls.push(p); spawnCount++; return `id${spawnCount}`; },
        waitForResult: async (id: string) => {
          return spawnCount === 1
            ? { id, status: "aborted", reason: "step-limit", turnCount: 1 } as any
            : { id, status: "completed", result: "done", turnCount: 1, reportPayload: { findings: ["f"], artifacts: [] } } as any;
        },
        getRecord: () => ({ id: "id1", status: "completed", turnCount: 1 } as any),
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
    await tool.execute("tc1", { role: "coder", task: "x", retryCount: 1 }, undefined, undefined, {} as any);
    assert.equal(spawnCalls.length, 2, "attempt 1 (aborted) → retried once → attempt 2");
    // The two customTools arrays must carry DIFFERENT report tool instances
    // (the retry reconstructed one; the old code reused the outer-scope instance).
    assert.notEqual(spawnCalls[0].customTools[0], spawnCalls[1].customTools[0],
      "attempt 2 reconstructed the report tool (not the reused outer-scope instance) — T3-7");
  });
});
