import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReportTool, type ReportState } from "../src/report-tool";
import { DEFAULT_REPORT_SCHEMA, type ReportSchema } from "../src/contract";
import { extractReportPayload } from "../src/subagent/service";

// T1-3 end-to-end criterion: a role with a custom outputSchema round-trips
// through report_role_result WITHOUT falling back to finalText. Covers the full
// path the approver required: tool parameters reflect the custom schema (LLM
// CAN produce the call) → execute() stores the full payload → extractReportPayload
// recovers the full payload (not just findings/artifacts) → spawn_role would
// hand back {rootCause, fix} instead of {findings:[finalText]}.

const debuggerSchema: ReportSchema = {
  type: "object",
  required: ["rootCause", "fix"],
  properties: {
    rootCause: { type: "string" },
    fix: { type: "string" },
    testAdded: { type: "string" },
  },
};

describe("T1-3 end-to-end: custom-schema role round-trips through report_role_result", () => {
  it("the full chain: dynamic params → execute stores full payload → extractReportPayload recovers it", async () => {
    const state: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const tool = makeReportTool({ state, schema: debuggerSchema, failedStep: "debugger" });

    // 1. The LLM-facing tool parameters reflect the custom schema (so the model
    //    CAN produce a {rootCause, fix, testAdded} call, not just {findings, artifacts}).
    const props = (tool as any).parameters?.properties ?? {};
    assert.ok("rootCause" in props && "fix" in props && "testAdded" in props, "LLM sees custom fields");
    assert.ok(!("findings" in props), "LLLM does NOT see hardcoded findings");

    // 2. The role calls the tool with a custom-schema payload.
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/dbg.jsonl" } };
    const res = await (tool as any).execute("tc1", { rootCause: "null deref on line 42", fix: "guard added", testAdded: "test_guard.ts" }, undefined, undefined, ctx);
    assert.ok(!(res as any).terminate, "tool accepted the custom payload");

    // 3. service.extractReportPayload scans the child session messages for the
    //    toolCall and returns the FULL args (not just findings/artifacts).
    const childMessages = [
      { role: "user", content: [{ type: "text", text: "debug this" }] },
      { role: "assistant", content: [{ type: "text", text: "investigating..." }] },
      { role: "assistant", content: [{ type: "toolCall", name: "report_role_result", arguments: { rootCause: "null deref on line 42", fix: "guard added", testAdded: "test_guard.ts" } }] },
    ];
    const recovered = extractReportPayload(childMessages as any);
    assert.deepEqual(recovered, { rootCause: "null deref on line 42", fix: "guard added", testAdded: "test_guard.ts" }, "extractReportPayload returns the full custom payload, NOT {findings:[finalText]}");
  });

  it("default-schema role still round-trips as {findings, artifacts} (no regression)", async () => {
    const state: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const tool = makeReportTool({ state, schema: DEFAULT_REPORT_SCHEMA, failedStep: "coder" });
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/coder.jsonl" } };
    await (tool as any).execute("tc1", { findings: ["f1", "f2"], artifacts: ["a.ts"] }, undefined, undefined, ctx);
    const childMessages = [{ role: "assistant", content: [{ type: "toolCall", name: "report_role_result", arguments: { findings: ["f1", "f2"], artifacts: ["a.ts"] } }] }];
    const recovered = extractReportPayload(childMessages as any);
    assert.deepEqual(recovered, { findings: ["f1", "f2"], artifacts: ["a.ts"] }, "default schema unchanged");
  });
});
