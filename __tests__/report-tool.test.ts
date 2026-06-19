import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeReportTool, type ReportState } from "../src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "../src/contract";

// Direct execute() test — no pi runtime needed. We call execute with a fake ctx.
async function callExecute(state: ReportState, params: unknown) {
  const tool = makeReportTool({ state, schema: DEFAULT_REPORT_SCHEMA, failedStep: "pm" });
  // execute signature: (toolCallId, params, signal, onUpdate, ctx)
  return tool.execute("tc-1", params as any, undefined, undefined, {} as any);
}

function textOf(r: { content: any[] }): string { return r.content.map(c => c.text ?? "").join(""); }

// parse the JSON the tool embeds in content[0].text for error cases
function errJson(r: { content: any[] }): any { return JSON.parse(textOf(r)); }

describe("report tool", () => {
  it("accepts a valid payload, marks reported", async () => {
    const state: ReportState = { reported: false };
    const r = await callExecute(state, { findings: ["a"], artifacts: ["/x.md"] });
    assert.equal(state.reported, true);
    assert.match(textOf(r), /accepted/);
  });
  it("rejects missing required field with structured error (failedStep/errorType/message)", async () => {
    const state: ReportState = { reported: false };
    const r = await callExecute(state, { findings: ["a"] }); // artifacts missing
    const e = errJson(r);
    assert.equal(e.failedStep, "pm");
    assert.equal(e.errorType, "schema_mismatch");
    assert.match(e.message, /artifacts/);
    assert.equal(state.reported, false); // not marked on failure
  });
  it("rejects wrong type with structured error", async () => {
    const state: ReportState = { reported: false };
    const r = await callExecute(state, { findings: "not-array", artifacts: [] });
    const e = errJson(r);
    assert.equal(e.errorType, "schema_mismatch");
    assert.match(e.message, /findings/);
  });
  it("rejects a second call (once-only) with duplicate_report error", async () => {
    const state: ReportState = { reported: true }; // already reported
    const r = await callExecute(state, { findings: ["a"], artifacts: [] });
    const e = errJson(r);
    assert.equal(e.errorType, "duplicate_report");
    assert.match(e.message, /exactly once/);
  });
});
