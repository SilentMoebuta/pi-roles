import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateReport, buildStructuredError, type ReportPayload, type ReportSchema } from "../src/contract";

const schema: ReportSchema = {
  type: "object",
  required: ["findings", "artifacts"],
  properties: {
    findings: { type: "array" },
    artifacts: { type: "array" },
  },
};

describe("contract", () => {
  it("validateReport ok for matching payload", () => {
    const r = validateReport({ findings: ["a"], artifacts: ["/x.md"] }, schema);
    assert.equal(r.ok, true);
  });
  it("validateReport fails on missing required field", () => {
    const r = validateReport({ findings: ["a"] }, schema);
    assert.equal(r.ok, false);
    assert.match(r.error!, /artifacts/);
  });
  it("validateReport fails on wrong type", () => {
    const r = validateReport({ findings: "not-array", artifacts: [] }, schema);
    assert.equal(r.ok, false);
    assert.match(r.error!, /findings/);
  });
  it("buildStructuredError returns required shape", () => {
    const e = buildStructuredError({ failedStep: "pm-analyze", errorType: "schema_mismatch", message: "findings missing" });
    assert.equal(e.errorType, "schema_mismatch");
    assert.equal(e.failedStep, "pm-analyze");
    assert.equal(e.message, "findings missing");
    assert.equal(typeof e.timestamp, "number");
  });
});
