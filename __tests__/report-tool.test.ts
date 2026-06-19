import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReportTool, type ReportState } from "../src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "../src/contract";

// Direct execute() test — no pi runtime needed. We call execute with a fake ctx.
// ctx.sessionManager is omitted → resolveSessionKey falls back to "default".
async function callExecute(state: ReportState, params: unknown, ctx?: any) {
  const tool = makeReportTool({ state, schema: DEFAULT_REPORT_SCHEMA, failedStep: "pm" });
  // execute signature: (toolCallId, params, signal, onUpdate, ctx)
  return tool.execute("tc-1", params as any, undefined, undefined, ctx ?? ({} as any));
}

function freshState(): ReportState {
  return { reported: new Set<string>(), activeRole: new Map<string, string>(), payloads: new Map() };
}

function textOf(r: { content: any[] }): string { return r.content.map(c => c.text ?? "").join(""); }
function errJson(r: { content: any[] }): any { return JSON.parse(textOf(r)); }

// a ctx whose sessionManager returns a given session file key
function ctxWithSession(sessionFile: string | undefined): any {
  return { sessionManager: { getSessionFile: () => sessionFile } };
}

describe("report tool", () => {
  it("accepts a valid payload, marks reported for the session", async () => {
    const state = freshState();
    const r = await callExecute(state, { findings: ["a"], artifacts: ["/x.md"] });
    assert.equal(state.reported.has("default"), true);
    assert.match(textOf(r), /accepted/);
  });
  it("rejects missing required field with structured error (failedStep/errorType/message)", async () => {
    const state = freshState();
    const r = await callExecute(state, { findings: ["a"] }); // artifacts missing
    const e = errJson(r);
    assert.equal(e.failedStep, "pm");
    assert.equal(e.errorType, "schema_mismatch");
    assert.match(e.message, /artifacts/);
    assert.equal(state.reported.has("default"), false); // not marked on failure
    assert.equal((r as any).terminate, undefined); // schema_mismatch leaves terminate unset (agent may retry)
  });
  it("rejects wrong type with structured error", async () => {
    const state = freshState();
    const r = await callExecute(state, { findings: "not-array", artifacts: [] });
    const e = errJson(r);
    assert.equal(e.errorType, "schema_mismatch");
    assert.match(e.message, /findings/);
  });
  it("rejects a second call (once-only) with duplicate_report error AND terminate", async () => {
    const state = freshState();
    state.reported.add("default"); // already reported for this session
    const r = await callExecute(state, { findings: ["a"], artifacts: [] });
    const e = errJson(r);
    assert.equal(e.errorType, "duplicate_report");
    assert.match(e.message, /exactly once/);
    assert.equal((r as any).terminate, true); // role is done; stop the agent
  });

  // CRITICAL fix: per-session keying — a second role session in the same runtime
  // must NOT be rejected as a duplicate of the first.
  it("keys reported per session: second session can still report after first did", async () => {
    const state = freshState();
    const r1 = await callExecute(state, { findings: ["a"], artifacts: ["/x.md"] }, ctxWithSession("/sessions/s1.jsonl"));
    assert.match(textOf(r1), /accepted/);
    assert.equal(state.reported.has("/sessions/s1.jsonl"), true);
    assert.equal(state.reported.has("/sessions/s2.jsonl"), false);
    // Same runtime, different session: must NOT be flagged duplicate.
    const r2 = await callExecute(state, { findings: ["b"], artifacts: ["/y.md"] }, ctxWithSession("/sessions/s2.jsonl"));
    assert.match(textOf(r2), /accepted/);
    assert.equal(state.reported.has("/sessions/s2.jsonl"), true);
    // A third call on s1 IS a duplicate (once-only per session).
    const r3 = await callExecute(state, { findings: ["c"], artifacts: [] }, ctxWithSession("/sessions/s1.jsonl"));
    assert.equal(errJson(r3).errorType, "duplicate_report");
    assert.equal((r3 as any).terminate, true);
  });

  // SHOULD fix: failedStep binds to the active role for the session when present.
  it("uses activeRole failedStep when a role is bound for the session", async () => {
    const state = freshState();
    state.activeRole.set("/sessions/s1.jsonl", "researcher");
    const r = await callExecute(state, { findings: ["a"] }, ctxWithSession("/sessions/s1.jsonl"));
    assert.equal(errJson(r).failedStep, "researcher");
  });
});
