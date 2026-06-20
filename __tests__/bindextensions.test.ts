import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// report_role_result visibility fix (root cause: pi-roles spawn path never
// called session.bindExtensions, so the session_start handler that additively
// adds report_role_result to a role session's active tools NEVER fired).
// This test proves the service now calls bindExtensions before prompt — which
// is the precondition for the handler to run. The live "child can actually call
// report_role_result" leg is verified by the goal-session smoke.

function recordingSession(events: string[]): { session: SubagentSession } {
  const listeners: Array<(e: any) => void> = [];
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => {},
    bindExtensions: async (_bindings?: { mode?: string }) => { events.push("bindExtensions"); },
    prompt: async () => {
      events.push("prompt");
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session };
}

function makeDeps(session: SubagentSession): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => "/tmp/child.jsonl",
    }) as any,
    createSession: async () => ({ session }),
  };
}

describe("report_role_result fix — service calls bindExtensions before prompt", () => {
  it("bindExtensions is called BEFORE prompt (so session_start handler fires and adds report_role_result)", async () => {
    const events: string[] = [];
    const { session } = recordingSession(events);
    const service = new SubagentsService(makeDeps(session), { cwd: "/p", agentDir: "/.pi" });
    const id = service.spawn({ role: "reviewer", task: "x", maxTurns: 1, parentSessionId: "parent-1" });
    await service.waitForResult(id);
    assert.ok(events.includes("bindExtensions"), "bindExtensions was called");
    assert.ok(events.includes("prompt"), "prompt was called");
    assert.ok(events.indexOf("bindExtensions") < events.indexOf("prompt"), "bindExtensions BEFORE prompt");
  });

  it("bindExtensions called with mode:'print' (non-interactive child)", async () => {
    let captured: any = undefined;
    const listeners: Array<(e: any) => void> = [];
    const session: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: () => {},
      abort: () => {},
      bindExtensions: async (b?: any) => { captured = b; },
      prompt: async () => { listeners.forEach((l) => l({ type: "agent_end" })); },
    };
    const service = new SubagentsService(makeDeps(session), { cwd: "/p", agentDir: "/.pi" });
    const id = service.spawn({ role: "reviewer", task: "x", maxTurns: 1, parentSessionId: "p1" });
    await service.waitForResult(id);
    assert.equal(captured?.mode, "print");
  });
});
