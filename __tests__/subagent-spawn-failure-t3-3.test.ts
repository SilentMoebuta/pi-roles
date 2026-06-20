import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SpawnDeps } from "../src/subagent/spawn";

// T3-3: runToCompletion spawn-failure path. If spawnRole throws (createAgentSession
// fails — auth/network), state.markRunning never ran (state stuck 'queued'), and
// onComplete sat AFTER registry.resolve in the try block → a BACKGROUND spawn that
// fails at session creation NEVER fires onComplete → the parent's join waits forever.
// Also registry.reject didn't transition state → getRecord reports 'queued' for a
// dead run. The approver required: (a) onComplete fires w/ status 'error', (b)
// getRecord().status==='error' (not 'queued'), (c) waitForResult rejects.

function throwingDeps(): SpawnDeps {
  return {
    makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "c", getSessionFile: () => "/tmp/c.jsonl" }) as any,
    createSession: async () => { throw new Error("createAgentSession failed (auth)"); },
  };
}

describe("SubagentsService — spawn-failure settle (T3-3)", () => {
  it("createSession throw → state 'error' (not 'queued'), waitForResult rejects, onComplete fires once w/ 'error'", async () => {
    const onCompleteCalls: any[] = [];
    const svc = new SubagentsService(throwingDeps(), { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({
      role: "reviewer", task: "x", maxTurns: 10, livenessMs: 0,
      onComplete: (rec: any) => onCompleteCalls.push(rec),
    } as any);

    // waitForResult should reject (the run failed at spawn).
    let rejected = false;
    await svc.waitForResult(id).catch(() => { rejected = true; });
    assert.equal(rejected, true, "waitForResult rejects on spawn failure (c)");

    const rec = svc.getRecord(id);
    assert.ok(rec, "record exists");
    assert.equal(rec!.status, "error", "getRecord().status === 'error' (not 'queued') (b)");

    assert.equal(onCompleteCalls.length, 1, "onComplete fires EXACTLY once (no double-fire)");
    assert.equal(onCompleteCalls[0].status, "error", "onComplete fired with status 'error' (a)");
    assert.match(onCompleteCalls[0].error ?? "", /createAgentSession failed/, "onComplete carries the spawn error");
  });
});
