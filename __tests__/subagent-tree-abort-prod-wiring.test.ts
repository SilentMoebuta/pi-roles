import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// Race a promise against a timeout so a hung cascade FAILS cleanly instead of
// hanging the suite (the T1-1 bug makes children hang forever when the cascade
// is a no-op). Without this, the suite stalls instead of reporting RED.
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT: " + msg)), ms)),
  ]);
}

// T1-1 (P0-2 regression guard): the ORIGINAL subagent-tree-abort.test.ts passes
// parentSessionId = an AGENT ID. Prod does NOT do that — spawn-role-tool.ts:237
// passes parentSessionId = the caller's SESSION FILE. So the `children` Map is
// keyed by sessionFile, but abort(id) walks by agent-id → the two key spaces
// never coincide → the cascade is a NO-OP in prod, while the test suite stays
// green (test/prod divergence — the original bug).
//
// These tests use PROD wiring: each spawn's parentSessionId is the parent's
// SESSION FILE (distinct per child, mirroring real SessionManager), and abort
// is called with the parent's AGENT ID (what a caller actually holds).
//
// We make the fake SessionManager hand out a deterministic, distinct sessionFile
// per spawn AND surface each spawned agent's sessionFile via the deps closure so
// the test can pass it as the next parentSessionId — exactly what
// ctx.sessionManager.getSessionFile() returns in prod at spawn-role-tool.ts:172.

function makeHangingSession(): SubagentSession {
  const listeners: Array<(e: any) => void> = [];
  let resolveHang: () => void = () => {};
  const hang = new Promise<void>((r) => { resolveHang = r; });
  return {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { resolveHang(); },
    prompt: async () => { await hang; listeners.forEach((l) => l({ type: "agent_end" })); },
  } as SubagentSession;
}

// Harness that records each spawn's sessionFile, keyed by the agent-id the
// registry assigns. service.runToCompletion calls sessionManager.getSessionFile()
// once per spawn; we capture the (agent-id → sessionFile) mapping by having the
// fake createSession stamp the id. Since the service doesn't pass the id into
// createSession, we instead make getSessionFile() deterministic per SessionManager
// instance: each spawn constructs a NEW SessionManager (makeSessionManager is
// called per spawn), so we hand out a fresh seq-derived file and record it in a
// shared map under the id we discover by waiting one tick + reading the handles.
//
// Simplest robust approach: make makeSessionManager return a SessionManager
// whose getSessionFile() returns a file derived from a shared counter, and we
// also stamp that file into `fileFor` keyed by the NEXT id the registry will
// hand out — but we can't know the id. So instead we expose the id→file mapping
// by capturing it inside a wrapper deps.createSession that the service calls
// AFTER registering the id. The service does NOT pass id to createSession either.
//
// Resolution: avoid needing the mapping at all. In prod, ctx.sessionManager.
// getSessionFile() returns the CALLER's own sessionFile — the caller KNOWS it.
// So the test can pass an EXPLICIT, known sessionFile string as parentSessionId
// for children, and a different known string for the parent's own file. We just
// need the parent's sessionFile to be discoverable so children can use it —
// which in prod is the parent's ctx.sessionManager.getSessionFile(). The test
// simulates that by giving each spawn a PREDICTABLE sessionFile (sf-<seq>) and
// having the test read the sequence. Cleanest: a single counter, and the test
// tracks sf-<n> per spawn in order.
function makeHarness() {
  let seq = 0;
  const filesInOrder: string[] = []; // sessionFile per spawn, in spawn() order
  const deps: SpawnDeps = {
    makeSessionManager: () => ({
      newSession: () => {},
      // distinct id per spawn (registry also assigns one, but the SM is consulted
      // for the file). We hand out sf-<seq> and record it so the test can pass it
      // as the next spawn's parentSessionId.
      getSessionId: () => `agent-${seq + 1}`,
      getSessionFile: () => { seq++; const f = `/tmp/sf-${seq}.jsonl`; filesInOrder.push(f); return f; },
    }) as any,
    createSession: async () => ({ session: makeHangingSession() }),
  };
  return { deps, filesInOrder };
}

describe("SubagentsService — tree abort PROD wiring (T1-1)", () => {
  it("abort(parentAgentId) cascades to children when parentSessionId is the parent's SESSION FILE (prod wiring)", async () => {
    const { deps, filesInOrder } = makeHarness();
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });

    // Parent spawned by main agent → parentSessionId is the main session file.
    const parent = svc.spawn({ role: "reviewer", task: "parent", maxTurns: 100, livenessMs: 0, parentSessionId: "main-session-file" });
    // Wait a tick for runToCompletion to run getSessionFile() (records the file).
    await new Promise((r) => setImmediate(r));
    const parentFile = filesInOrder[0]; // the parent's own sessionFile (prod: ctx.sessionManager.getSessionFile())
    assert.ok(parentFile, "harness recorded parent sessionFile");

    // Children use the parent's SESSION FILE as parentSessionId (prod wiring).
    const child1 = svc.spawn({ role: "coder", task: "c1", maxTurns: 100, livenessMs: 0, parentSessionId: parentFile });
    const child2 = svc.spawn({ role: "coder", task: "c2", maxTurns: 100, livenessMs: 0, parentSessionId: parentFile });
    await new Promise((r) => setImmediate(r));

    svc.abort(parent); // abort by AGENT ID (prod caller has the id, not the file)
    const [r1, r2, rp] = await Promise.all([
      withTimeout(svc.waitForResult(child1), 2000, "child1 hung — cascade no-op (T1-1 bug)"),
      withTimeout(svc.waitForResult(child2), 2000, "child2 hung — cascade no-op (T1-1 bug)"),
      withTimeout(svc.waitForResult(parent), 2000, "parent hung"),
    ]);
    assert.equal(r1.status, "aborted", "child1 aborted via parent cascade (prod wiring)");
    assert.equal(r2.status, "aborted", "child2 aborted via parent cascade (prod wiring)");
    assert.equal(rp.status, "aborted", "parent itself aborted");
  });

  it("grandchildren cascade 2 levels under prod wiring", async () => {
    const { deps, filesInOrder } = makeHarness();
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });
    const gp = svc.spawn({ role: "planner", task: "gp", maxTurns: 100, livenessMs: 0, parentSessionId: "main-session-file" });
    await new Promise((r) => setImmediate(r));
    const gpFile = filesInOrder[0];
    const parent = svc.spawn({ role: "reviewer", task: "p", maxTurns: 100, livenessMs: 0, parentSessionId: gpFile });
    await new Promise((r) => setImmediate(r));
    const parentFile = filesInOrder[1];
    const child = svc.spawn({ role: "coder", task: "c", maxTurns: 100, livenessMs: 0, parentSessionId: parentFile });
    await new Promise((r) => setImmediate(r));

    svc.abort(gp);
    const [rc, rp] = await Promise.all([
      withTimeout(svc.waitForResult(child), 2000, "grandchild hung — cascade no-op (T1-1 bug)"),
      withTimeout(svc.waitForResult(parent), 2000, "parent hung"),
    ]);
    assert.equal(rc.status, "aborted", "grandchild aborted via 2-level cascade (prod wiring)");
    assert.equal(rp.status, "aborted", "intermediate child also aborted");
  });

  it("abort(parentAgentId) reaches children spawned with parentSessionId=sessionFile — was a no-op before T1-1", async () => {
    // Inverse guard: the OLD code keyed `children` by sessionFile but walked by
    // agent-id, so this cascade was a no-op and the child hung forever. The fix
    // (agentToSessionFile reverse map) makes the child abort. Assert FIXED.
    const { deps, filesInOrder } = makeHarness();
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });
    const parent = svc.spawn({ role: "reviewer", task: "p", maxTurns: 100, livenessMs: 0, parentSessionId: "main-session-file" });
    await new Promise((r) => setImmediate(r));
    const parentFile = filesInOrder[0];
    const child = svc.spawn({ role: "coder", task: "c", maxTurns: 100, livenessMs: 0, parentSessionId: parentFile });
    await new Promise((r) => setImmediate(r));

    svc.abort(parent);
    const rc = await withTimeout(svc.waitForResult(child), 2000, "child hung — cascade no-op (T1-1 bug)");
    assert.equal(rc.status, "aborted", "child aborted (was a no-op before T1-1)");
    await svc.waitForResult(parent).catch(() => {});
  });
});
