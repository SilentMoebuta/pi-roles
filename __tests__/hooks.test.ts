import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hooks, type HookContext } from "../src/hooks";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// P0-3: lifecycle hooks — verify hooks fire at correct lifecycle points
// with sequential ordering and error isolation.

function makeFakeSession(ms = 5): SubagentSession {
  const listeners: Array<(e: any) => void> = [];
  return {
    subscribe: (l: any) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => {},
    bindExtensions: async () => {},
    prompt: async () => {
      await new Promise((r) => setTimeout(r, ms));
      listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  } as SubagentSession;
}

function makeDeps(session: SubagentSession): SpawnDeps {
  return {
    makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "c", getSessionFile: () => "/tmp/c.jsonl" }) as any,
    createSession: async () => ({ session }),
  };
}

describe("lifecycle hooks (P0-3)", () => {
  // Each test self-clears for isolation (singleton hooks accumulate across tests).

  it("spawn:before and spawn:after fire in correct order", async () => {
    hooks.clear();
    const events: string[] = [];
    hooks.on("subagent_spawn:before", async () => { events.push("before"); });
    hooks.on("subagent_spawn:after", async () => { events.push("after"); });

    const svc = new SubagentsService(makeDeps(makeFakeSession()), { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "coder", task: "x", maxTurns: 1 });
    await svc.waitForResult(id);

    assert.deepEqual(events, ["before", "after"]);
    hooks.clear();
  });

  it("subagent_complete fires for successful runs", async () => {
    hooks.clear();
    let captured: HookContext | null = null;
    hooks.on("subagent_complete", async (c) => { captured = c; });

    const svc = new SubagentsService(makeDeps(makeFakeSession()), { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "reviewer", task: "review", maxTurns: 1, parentSessionId: "p1" });
    await svc.waitForResult(id);

    assert.ok(captured, "complete handler fired");
    assert.equal((captured as HookContext).id, id);
    assert.equal((captured as HookContext).status, "completed");
    hooks.clear();
  });

  it("hook errors don't crash the subagent — subsequent handlers fire", async () => {
    hooks.clear();
    const events: string[] = [];
    hooks.on("subagent_spawn:before", async () => { throw new Error("boom"); });
    hooks.on("subagent_spawn:before", async () => { events.push("second"); });

    const svc = new SubagentsService(makeDeps(makeFakeSession()), { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "coder", task: "x", maxTurns: 1 });
    await svc.waitForResult(id);

    assert.deepEqual(events, ["second"], "second handler still fired after first threw");
    // subagent completed normally despite hook error
    const rec = svc.getRecord(id);
    assert.ok(rec, "record exists");
    assert.equal(rec!.status, "completed");
    hooks.clear();
  });

  it("handlers fire sequentially, not in parallel", async () => {
    hooks.clear();
    const order: string[] = [];
    hooks.on("subagent_spawn:before", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("first");
    });
    hooks.on("subagent_spawn:before", async () => {
      order.push("second");
    });

    const svc = new SubagentsService(makeDeps(makeFakeSession()), { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "coder", task: "x", maxTurns: 1 });
    await svc.waitForResult(id);

    assert.deepEqual(order, ["first", "second"], "sequential — second only after first resolves");
    hooks.clear();
  });
});
