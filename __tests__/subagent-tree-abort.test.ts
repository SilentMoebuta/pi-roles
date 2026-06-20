import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// P0-2: tree-based abort propagation. Each spawn gets its OWN fake session
// that hangs until aborted (mirrors real pi session.abort() resolving prompt).

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

function makeDeps(): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => "/tmp/child.jsonl",
    }) as any,
    createSession: async () => ({ session: makeHangingSession() }),
  };
}

describe("SubagentsService — tree abort (P0-2)", () => {
  it("abort(parent) recursively aborts all children", async () => {
    const svc = new SubagentsService(makeDeps(), { cwd: "/p", agentDir: "/.pi" });
    const parent = svc.spawn({ role: "reviewer", task: "parent", maxTurns: 100, livenessMs: 0, parentSessionId: "root" });
    const child1 = svc.spawn({ role: "coder", task: "c1", maxTurns: 100, livenessMs: 0, parentSessionId: parent });
    const child2 = svc.spawn({ role: "coder", task: "c2", maxTurns: 100, livenessMs: 0, parentSessionId: parent });

    svc.abort(parent);
    const [r1, r2] = await Promise.all([svc.waitForResult(child1), svc.waitForResult(child2)]);
    assert.equal(r1.status, "aborted", "child1 aborted via parent cascade");
    assert.equal(r2.status, "aborted", "child2 aborted via parent cascade");
  });

  it("abort(child) does NOT abort parent or siblings", async () => {
    const svc = new SubagentsService(makeDeps(), { cwd: "/p", agentDir: "/.pi" });
    const parent = svc.spawn({ role: "reviewer", task: "p", maxTurns: 100, livenessMs: 0, parentSessionId: "root" });
    const child1 = svc.spawn({ role: "coder", task: "c1", maxTurns: 100, livenessMs: 0, parentSessionId: parent });
    const child2 = svc.spawn({ role: "coder", task: "c2", maxTurns: 100, livenessMs: 0, parentSessionId: parent });

    svc.abort(child1);
    const r1 = await svc.waitForResult(child1);
    assert.equal(r1.status, "aborted", "child1 is aborted");

    // child2 + parent still running (NOT aborted)
    assert.ok(svc.getRecord(child2)?.status !== "aborted", "child2 NOT aborted");
    assert.ok(svc.getRecord(parent)?.status !== "aborted", "parent NOT aborted");
    // cleanup
    svc.abort(parent);
  });

  it("abort unknown id returns false", () => {
    const svc = new SubagentsService(makeDeps(), { cwd: "/p", agentDir: "/.pi" });
    assert.equal(svc.abort("nope"), false);
  });

  it("grandchildren are recursively aborted (2-level cascade)", async () => {
    const svc = new SubagentsService(makeDeps(), { cwd: "/p", agentDir: "/.pi" });
    const gp = svc.spawn({ role: "planner", task: "gp", maxTurns: 100, livenessMs: 0, parentSessionId: "root" });
    const parent = svc.spawn({ role: "reviewer", task: "p", maxTurns: 100, livenessMs: 0, parentSessionId: gp });
    const child = svc.spawn({ role: "coder", task: "c", maxTurns: 100, livenessMs: 0, parentSessionId: parent });

    svc.abort(gp);
    const [rc, rp] = await Promise.all([svc.waitForResult(child), svc.waitForResult(parent)]);
    assert.equal(rc.status, "aborted", "grandchild aborted via 2-level cascade");
    assert.equal(rp.status, "aborted", "intermediate child also aborted");
  });
});
