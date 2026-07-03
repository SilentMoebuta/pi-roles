import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService, type SubagentServiceParams } from "../src/subagent/service";
import type { SpawnDeps } from "../src/subagent/spawn";

// B-cleanup: after a role subagent run completes, its child session .jsonl file
// is archived (renamed to .archived.<ts>) so it disappears from pi's session-tree
// dir scan (pi only scans *.jsonl) while preserving the transcript for audit.

function makeFakeSession(turns = 1, assistantText = "done") {
  const listeners: Array<(e: any) => void> = [];
  let aborted = false;
  const session: any = {
    subscribe: (l: any) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; },
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }));
        listeners.forEach((l) => l({ type: "turn_end" }));
      }
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session };
}

function makeDeps(fakeSession: any, sessionFile = "/tmp/child.jsonl"): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => sessionFile,
    }) as any,
    createSession: async () => ({ session: fakeSession }),
  };
}

describe("B-cleanup: child session archived after run", () => {
  it("archives the child session file (rename to .archived.<ts>) after the run resolves", async () => {
    const fake = makeFakeSession(1, "done");
    const archived: string[] = [];
    const svc = new SubagentsService(makeDeps(fake.session, "/tmp/child.jsonl"), {
      cwd: "/p", agentDir: "/.pi",
      archiveSession: (file) => { archived.push(file); return file; },
    });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 10 } as SubagentServiceParams);
    await svc.waitForResult(id);
    assert.equal(archived.length, 1, "archive called once");
    assert.equal(archived[0], "/tmp/child.jsonl", "archived the child session file");
  });

  it("archives even when the run aborts (step-limit) — cleanup is unconditional", async () => {
    const fake = makeFakeSession(50, "working");
    const archived: string[] = [];
    const svc = new SubagentsService(makeDeps(fake.session, "/tmp/c.jsonl"), {
      cwd: "/p", agentDir: "/.pi", archiveSession: (file) => { archived.push(file); return file; },
    });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 2 } as SubagentServiceParams);
    await svc.waitForResult(id);
    assert.equal(archived.length, 1, "archived even on abort");
    assert.equal(archived[0], "/tmp/c.jsonl");
  });

  it("does NOT archive when sessionFile is absent (graceful — nothing to clean)", async () => {
    const fake = makeFakeSession(1);
    const archived: string[] = [];
    const deps: SpawnDeps = {
      makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "child-id", getSessionFile: () => undefined }) as any,
      createSession: async () => ({ session: fake.session }),
    };
    const svc = new SubagentsService(deps, {
      cwd: "/p", agentDir: "/.pi", archiveSession: (file) => { archived.push(file); return file; },
    });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 10 } as SubagentServiceParams);
    await svc.waitForResult(id);
    assert.equal(archived.length, 0, "no archive call when no sessionFile");
  });

  it("archive errors do not crash the run (best-effort cleanup)", async () => {
    const fake = makeFakeSession(1);
    const svc = new SubagentsService(makeDeps(fake.session, "/tmp/child.jsonl"), {
      cwd: "/p", agentDir: "/.pi",
      archiveSession: () => { throw new Error("fs busy"); },
    });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 10 } as SubagentServiceParams);
    // should not reject — archive error swallowed
    const rec = await svc.waitForResult(id);
    assert.equal(rec.status, "completed", "run still completes despite archive error");
  });
});
