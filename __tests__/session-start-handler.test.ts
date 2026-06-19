import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeRoleSessionStartHandler, type SessionStartDeps } from "../src/subagent/session-start-handler";

// A-fix: report_role_result is invisible to role subagents because createAgentSession
// applies the tools allowlist (initialActiveToolNames) BEFORE extensions register
// report_role_result. By session_start (fired after extensions load), the tool IS
// registered but not in the active set. Fix: for role sessions (parentSession present),
// additively add report_role_result to active tools — WITHOUT touching the role's
// whitelist (reviewer stays read-only; only report_role_result is added).

function deps(activeTools: string[]): { handler: any; calls: string[][] } {
  const calls: string[][] = [];
  const d: SessionStartDeps = {
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { calls.push(names); },
  };
  return { handler: makeRoleSessionStartHandler(d), calls };
}

function ctx(parentSession?: string) {
  return { sessionManager: { getHeader: () => (parentSession ? { parentSession } : {}) } } as any;
}

describe("makeRoleSessionStartHandler (A: report_role_result visibility)", () => {
  it("role session (parentSession present) + report_role_result missing → adds it additively", () => {
    const { handler, calls } = deps(["read", "bash", "grep", "find", "ls"]); // reviewer whitelist, no report_role_result
    handler({ type: "session_start", reason: "startup" }, ctx("parent-1"));
    assert.equal(calls.length, 1, "setActiveTools called once");
    assert.deepEqual(calls[0].sort(), ["read", "bash", "grep", "find", "ls", "report_role_result"].sort());
  });

  it("role session + report_role_result already active → no change (idempotent)", () => {
    const { handler, calls } = deps(["read", "bash", "report_role_result"]);
    handler({ type: "session_start", reason: "startup" }, ctx("parent-1"));
    assert.equal(calls.length, 0, "no setActiveTools call when already active");
  });

  it("non-role session (no parentSession) → no change (main agent untouched)", () => {
    const { handler, calls } = deps(["read", "bash"]);
    handler({ type: "session_start", reason: "startup" }, ctx(undefined)); // no parentSession
    assert.equal(calls.length, 0, "no change for main session");
  });

  it("role session with write/edit (debugger) → adds report_role_result ONLY, preserves write/edit", () => {
    const { handler, calls } = deps(["read", "bash", "write", "edit", "grep", "find", "ls"]); // debugger whitelist
    handler({ type: "session_start", reason: "startup" }, ctx("parent-1"));
    assert.equal(calls.length, 1);
    // write/edit preserved; report_role_result added; nothing else added
    assert.ok(calls[0].includes("write"), "write preserved");
    assert.ok(calls[0].includes("edit"), "edit preserved");
    assert.ok(calls[0].includes("report_role_result"), "report_role_result added");
    assert.equal(calls[0].length, 8, "only report_role_result added (7+1)");
  });

  it("handles missing getHeader gracefully (no crash)", () => {
    const { handler, calls } = deps(["read"]);
    handler({ type: "session_start", reason: "startup" }, { sessionManager: {} } as any); // no getHeader
    assert.equal(calls.length, 0, "no crash, no change");
  });

  it("handles missing sessionManager gracefully (no crash)", () => {
    const { handler, calls } = deps(["read"]);
    handler({ type: "session_start", reason: "startup" }, {} as any); // no sessionManager
    assert.equal(calls.length, 0, "no crash, no change");
  });
});
