import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnRole, type SpawnDeps } from "../src/subagent/spawn";

// spawnRole builds the child session: constructs a SessionManager, calls
// newSession({parentSession}) to set the header (so the 3 isSubagentSession
// guards detect the child), and calls createSession with the role tool allowlist.
// Injectable deps → no real pi needed for logic tests.

interface Calls {
  newSession: unknown[];
  createSession: unknown[];
}

function makeDeps(calls: Calls, session: any): SpawnDeps {
  return {
    makeSessionManager: (_cwd) => ({
      newSession: (opts?: unknown) => { calls.newSession.push(opts); },
      getSessionId: () => "child-sess-id",
      getSessionFile: () => "/tmp/child.jsonl",
    } as unknown as any),
    createSession: async (opts) => {
      calls.createSession.push(opts);
      return { session };
    },
  };
}

describe("spawnRole", () => {
  it("sets parentSession header when parentSessionId provided (isSubagentSession detection)", async () => {
    const calls = { newSession: [], createSession: [] };
    const deps = makeDeps(calls, {});
    const res = await spawnRole(deps, {
      cwd: "/p", agentDir: "/.pi", parentSessionId: "parent-123", task: "do thing", tools: ["read", "bash"],
    });
    assert.equal(res.parentSessionSet, true);
    assert.deepEqual(calls.newSession, [{ parentSession: "parent-123" }]);
    assert.equal(res.sessionId, "child-sess-id");
    assert.equal(res.sessionFile, "/tmp/child.jsonl");
  });

  it("does NOT set parentSession when parentSessionId omitted (top-level spawn)", async () => {
    const calls = { newSession: [], createSession: [] };
    const deps = makeDeps(calls, {});
    const res = await spawnRole(deps, { cwd: "/p", agentDir: "/.pi", task: "x" });
    assert.equal(res.parentSessionSet, false);
    // newSession may still be called (to start a fresh session) but without parentSession
    for (const opts of calls.newSession) {
      assert.deepEqual(opts, {} as object, "no parentSession key when none provided");
    }
  });

  it("passes the role tool allowlist to createSession", async () => {
    const calls = { newSession: [], createSession: [] };
    const deps = makeDeps(calls, {});
    await spawnRole(deps, { cwd: "/p", agentDir: "/.pi", task: "x", tools: ["read", "bash", "grep"] });
    assert.equal(calls.createSession.length, 1);
    assert.deepEqual((calls.createSession[0] as any).tools, ["read", "bash", "grep"]);
  });

  it("passes cwd/agentDir/sessionManager to createSession", async () => {
    const calls = { newSession: [], createSession: [] };
    const deps = makeDeps(calls, {});
    await spawnRole(deps, { cwd: "/proj", agentDir: "/agentdir", parentSessionId: "p", task: "x" });
    const opts = calls.createSession[0] as any;
    assert.equal(opts.cwd, "/proj");
    assert.equal(opts.agentDir, "/agentdir");
    assert.ok(opts.sessionManager, "sessionManager passed through");
  });

  it("returns the created session", async () => {
    const calls = { newSession: [], createSession: [] };
    const sentinel = { prompt: () => {} };
    const deps = makeDeps(calls, sentinel);
    const res = await spawnRole(deps, { cwd: "/p", agentDir: "/.pi", parentSessionId: "p", task: "x" });
    assert.equal(res.session, sentinel);
  });

  it("forwards model to createSession when provided", async () => {
    const calls = { newSession: [], createSession: [] };
    const deps = makeDeps(calls, {});
    const model = { id: "test-model" } as any;
    await spawnRole(deps, { cwd: "/p", agentDir: "/.pi", task: "x", model });
    assert.equal((calls.createSession[0] as any).model, model);
  });
});
