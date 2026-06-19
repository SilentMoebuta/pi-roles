import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService, type SubagentServiceParams } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// SubagentsService: spawn returns an id immediately (non-blocking); the run
// proceeds async and settles the registry. waitForResult(id) awaits the
// completion promise (the gap gotgenes' public API left open). abort(id)
// cancels a run via an AbortController.

function makeFakeSession(turns: number, assistantText = "done") {
  const listeners: Array<(e: any) => void> = [];
  let aborted = false;
  let resolveHang: () => void = () => {};
  const hang = new Promise<void>((r) => { resolveHang = r; });
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; resolveHang(); },
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }));
        listeners.forEach((l) => l({ type: "turn_end" }));
        await new Promise((r) => setTimeout(r, 1));
      }
      if (turns === 0 && aborted === false) {
        // hang until aborted (for abort tests)
        await hang;
      }
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session, wasAborted: () => aborted };
}

function makeDeps(fakeSession: SubagentSession): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => "/tmp/child.jsonl",
    }) as any,
    createSession: async () => ({ session: fakeSession }),
  };
}

function svc(fakeSession: SubagentSession): SubagentsService {
  return new SubagentsService(makeDeps(fakeSession), { cwd: "/p", agentDir: "/.pi" });
}

describe("SubagentsService", () => {
  it("spawn returns an id immediately; getRecord shows the run", () => {
    const fake = makeFakeSession(1);
    const s = svc(fake.session);
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 10, parentSessionId: "p1" });
    assert.ok(id);
    const rec = s.getRecord(id);
    assert.ok(rec);
    assert.equal(rec!.status === "queued" || rec!.status === "running", true);
  });

  it("waitForResult resolves with completed record when the run finishes", async () => {
    const fake = makeFakeSession(2, "final answer");
    const s = svc(fake.session);
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 10 });
    const rec = await s.waitForResult(id);
    assert.equal(rec.status, "completed");
    assert.equal(rec.result, "final answer");
    assert.equal(rec.turnCount, 2);
  });

  it("abort(id) cancels a running run; record becomes aborted", async () => {
    const fake = makeFakeSession(0); // hangs until aborted
    const s = svc(fake.session);
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 100, livenessMs: 0 });
    // give the runner a tick to start
    await new Promise((r) => setTimeout(r, 5));
    const ok = s.abort(id);
    assert.equal(ok, true);
    assert.equal(fake.wasAborted(), true);
    const rec = await s.waitForResult(id);
    assert.equal(rec.status, "aborted");
    assert.equal(rec.reason, "caller-abort");
  });

  it("abort unknown id returns false", () => {
    const fake = makeFakeSession(1);
    const s = svc(fake.session);
    assert.equal(s.abort("nope"), false);
  });

  it("maxTurns enforced: run aborts at step-limit via the service", async () => {
    const fake = makeFakeSession(50, "working"); // would run 50 turns
    const s = svc(fake.session);
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 2 });
    const rec = await s.waitForResult(id);
    assert.equal(rec.status, "aborted");
    assert.equal(rec.reason, "step-limit");
    assert.equal(rec.turnCount, 2);
    assert.equal(fake.wasAborted(), true);
  });

  it("hasRunning true during run, false after completion", async () => {
    const fake = makeFakeSession(1);
    const s = svc(fake.session);
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 10 });
    // may or may not be running yet, but after await it must be false
    await s.waitForResult(id);
    assert.equal(s.hasRunning(), false);
  });

  it("listAgents includes spawned ids", () => {
    const fake = makeFakeSession(1);
    const s = svc(fake.session);
    const a = s.spawn({ role: "reviewer", task: "x", maxTurns: 10 });
    const b = s.spawn({ role: "coder", task: "y", maxTurns: 10 });
    const ids = s.listAgents();
    assert.ok(ids.includes(a));
    assert.ok(ids.includes(b));
  });

  it("parentSessionId passed through to spawn (sets header for isSubagentSession)", async () => {
    const fake = makeFakeSession(1);
    let newSessionCalls: any[] = [];
    const deps: SpawnDeps = {
      makeSessionManager: () => ({
        newSession: (opts?: any) => { newSessionCalls.push(opts); },
        getSessionId: () => "child-id",
        getSessionFile: () => "/tmp/c.jsonl",
      }) as any,
      createSession: async () => ({ session: fake.session }),
    };
    const s = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });
    const id = s.spawn({ role: "reviewer", task: "x", maxTurns: 10, parentSessionId: "parent-xyz" });
    await s.waitForResult(id);
    assert.deepEqual(newSessionCalls, [{ parentSession: "parent-xyz" }]);
  });
});
