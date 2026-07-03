// TDD for the sessionFile-stale bug found 2026-07-03 during G3 live verification
// (deep-fix D residual gap). spawn_role returned sessionFile was the PRE-archive
// path; defaultArchiveSession moves the file to sessions-archive/, so the
// returned path was stale (ENOENT) — the G3 handler reading it failed:
//   "reviewerSessionFile unreadable: ... (ENOENT). Cannot verify the reviewer
//    actually reported (G3)."
// Fix: defaultArchiveSession returns the dest path; service.ts propagates the
// archived path to the record (resolve/onComplete/hook) so callers receive a
// readable path.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

function makeFakeSession(turns: number) {
  const listeners: Array<(e: any) => void> = [];
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => {},
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
        listeners.forEach((l) => l({ type: "turn_end" }));
        await new Promise((r) => setTimeout(r, 1));
      }
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return session;
}

describe("spawn returned sessionFile is the archived (readable) path — G3 live bug", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sf-archive-"));
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it("after completion, rec.sessionFile points to a file that EXISTS on disk (post-archive, not stale)", async () => {
    // Mirror pi layout: <tmpRoot>/sessions/<encoded-cwd>/child.jsonl
    const encodedCwd = "--home-test-project--";
    const liveDir = path.join(tmpRoot, "sessions", encodedCwd);
    fs.mkdirSync(liveDir, { recursive: true });
    const childFile = path.join(liveDir, "2026-07-03T01-00-00-000Z_child.jsonl");
    fs.writeFileSync(childFile, '{"type":"session"}\n');

    const fakeSession = makeFakeSession(1);
    const deps: SpawnDeps = {
      makeSessionManager: () => ({
        newSession: () => {},
        getSessionId: () => "child-id",
        getSessionFile: () => childFile,
      }) as any,
      createSession: async () => ({ session: fakeSession }),
    };
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 10, parentSessionId: "p1" });
    const rec = await svc.waitForResult(id);

    // BUG (pre-fix): rec.sessionFile is the pre-archive path → file moved → ENOENT.
    // FIX (post-fix): rec.sessionFile is the archived path → file exists + readable.
    assert.ok(rec.sessionFile, "record must carry a sessionFile");
    assert.ok(
      fs.existsSync(rec.sessionFile),
      `rec.sessionFile must be readable (post-archive); got stale path: ${rec.sessionFile}`,
    );
    // Original moved out of the live dir (archive did its job)
    assert.ok(!fs.existsSync(childFile), "original child file moved out of live dir");
    // The readable path is under sessions-archive (not the live dir)
    assert.match(rec.sessionFile, /sessions-archive/, "readable path is in the centralized archive dir");
  });

  it("aborted runs also propagate the archived (readable) sessionFile", async () => {
    const encodedCwd = "--home-test-abort--";
    const liveDir = path.join(tmpRoot, "sessions", encodedCwd);
    fs.mkdirSync(liveDir, { recursive: true });
    const childFile = path.join(liveDir, "2026-07-03T02-00-00-000Z_child.jsonl");
    fs.writeFileSync(childFile, '{"type":"session"}\n');

    // 1 turn then abort via maxTurns=1
    const fakeSession = makeFakeSession(3);
    const deps: SpawnDeps = {
      makeSessionManager: () => ({
        newSession: () => {},
        getSessionId: () => "child-id",
        getSessionFile: () => childFile,
      }) as any,
      createSession: async () => ({ session: fakeSession }),
    };
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi" });
    const id = svc.spawn({ role: "reviewer", task: "x", maxTurns: 1, parentSessionId: "p1" });
    const rec = await svc.waitForResult(id);

    assert.equal(rec.status, "aborted");
    assert.ok(rec.sessionFile, "aborted record must carry a sessionFile");
    assert.ok(
      fs.existsSync(rec.sessionFile),
      `aborted rec.sessionFile must be readable (post-archive); got: ${rec.sessionFile}`,
    );
  });
});
