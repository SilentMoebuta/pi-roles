import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReportTool, type ReportState } from "../src/report-tool";
import { DEFAULT_REPORT_SCHEMA, type ReportSchema } from "../src/contract";

// T1-3 (P1-6): outputSchema was non-functional end-to-end. makeReportTool
// hardcoded parameters: {findings, artifacts}, so the LLM saw only that schema
// and could NEVER produce a custom-schema call (e.g. {rootCause, fix}). Even if
// a role declared outputSchema, the data was discarded at storage
// (payloads.set(sk, {findings, artifacts})) AND at extraction
// (extractReportPayload only accepted array-typed findings/artifacts) → fell
// back to finalText. The approver caught that a test calling execute() directly
// with custom fields would GREEN while prod stayed broken (test/prod divergence,
// same anti-pattern as P0-2).

function freshState(): ReportState {
  return { reported: new Set(), activeRole: new Map(), payloads: new Map() };
}

const customSchema: ReportSchema = {
  type: "object",
  required: ["rootCause", "fix"],
  properties: { rootCause: { type: "string" }, fix: { type: "string" }, testAdded: { type: "string" } },
};

describe("report_role_result — dynamic schema (T1-3)", () => {
  it("makeReportTool surfaces the CUSTOM schema as the LLM-facing tool parameters (not hardcoded findings/artifacts)", () => {
    const tool = makeReportTool({ state: freshState(), schema: customSchema, failedStep: "debugger" });
    const props = (tool as any).parameters?.properties ?? {};
    const required = (tool as any).parameters?.required ?? [];
    assert.ok("rootCause" in props, "tool.parameters exposes rootCause (custom schema)");
    assert.ok("fix" in props, "tool.parameters exposes fix (custom schema)");
    assert.ok(!("findings" in props), "tool.parameters does NOT leak hardcoded findings under custom schema");
    assert.ok(!("artifacts" in props), "tool.parameters does NOT leak hardcoded artifacts under custom schema");
    assert.deepEqual([...required].sort(), ["fix", "rootCause"], "required reflects custom schema");
  });

  it("default schema still exposes findings/artifacts (no regression)", () => {
    const tool = makeReportTool({ state: freshState(), schema: DEFAULT_REPORT_SCHEMA, failedStep: "coder" });
    const props = (tool as any).parameters?.properties ?? {};
    assert.ok("findings" in props, "default schema still has findings");
    assert.ok("artifacts" in props, "default schema still has artifacts");
    assert.deepEqual([...((tool as any).parameters?.required ?? [])].sort(), ["artifacts", "findings"]);
  });

  it("execute() with a custom-schema payload stores the FULL object (not just findings/artifacts)", async () => {
    const state = freshState();
    const tool = makeReportTool({ state, schema: customSchema, failedStep: "debugger" });
    // Bind the session key to a known value by passing a ctx with a sessionManager.
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/child.jsonl" } };
    const res = await (tool as any).execute("tc1", { rootCause: "null deref", fix: "guard added", testAdded: "test_guard.ts" }, undefined, undefined, ctx);
    assert.ok(!(res as any).terminate, "accepted (not a schema error)");
    const stored = state.payloads.get("/tmp/child.jsonl");
    assert.deepEqual(stored, { rootCause: "null deref", fix: "guard added", testAdded: "test_guard.ts" }, "full custom payload stored, not flattened to findings/artifacts");
  });

  it("enforces scalar enum values before a typed result is accepted", async () => {
    const state = freshState();
    const schema: ReportSchema = {
      type: "object",
      required: ["decision"],
      properties: { decision: { type: "string", enum: ["accept", "revise", "blocked"] } },
    };
    const tool = makeReportTool({ state, schema, failedStep: "goal-reviewer" });
    const params = (tool as any).parameters?.properties?.decision;
    assert.deepEqual(params.anyOf?.map((entry: any) => entry.const), ["accept", "revise", "blocked"]);

    const ctx = { sessionManager: { getSessionFile: () => "/tmp/reviewer.jsonl" } };
    const rejected = await (tool as any).execute("bad", { decision: "verified" }, undefined, undefined, ctx);
    assert.equal((rejected as any).details?.errorType, "schema_mismatch");
    assert.match((rejected as any).details?.message ?? "", /accept.*revise.*blocked/);

    const accepted = await (tool as any).execute("good", { decision: "accept" }, undefined, undefined, ctx);
    assert.equal((accepted as any).details, undefined);
    assert.deepEqual(state.payloads.get("/tmp/reviewer.jsonl"), { decision: "accept" });
  });
});
