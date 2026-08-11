import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ReportSchema } from "../src/contract";
import { makeReportTool } from "../src/report-tool";
import {
  appendRoleResultConstraints,
  constrainRoleOutputSchema,
} from "../src/subagent/result-constraints";

const REVIEW_SCHEMA: ReportSchema = {
  type: "object",
  required: ["decision", "summary", "criterionCoverage", "findings", "artifacts"],
  properties: {
    decision: { type: "string", enum: ["accept", "revise", "blocked"] },
    summary: { type: "string" },
    criterionCoverage: {
      type: "array",
      items: {
        type: "object",
        required: ["criterionId", "status", "evidenceIds"],
        properties: {
          criterionId: { type: "string" },
          status: { type: "string", enum: ["satisfied", "unsatisfied", "blocked"] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["evidenceRefs"],
        properties: { evidenceRefs: { type: "array", items: { type: "string" } } },
      },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        required: ["uri", "digest", "sizeBytes"],
        properties: {
          uri: { type: "string" },
          digest: { type: "string" },
          sizeBytes: { type: "number" },
        },
      },
    },
  },
};

const CONSTRAINTS = {
  criterionIds: ["c1", "c2"],
  evidenceIds: ["ev-source", "ev-artifact"],
  artifactUris: ["outputs/result.md"],
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    decision: "accept",
    summary: "Verified.",
    criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceIds: ["ev-source"] }],
    findings: [],
    artifacts: [{ uri: "outputs/result.md", digest: "a".repeat(64), sizeBytes: 12 }],
    ...overrides,
  };
}

describe("dynamic role result constraints", () => {
  it("does not mutate the reusable role schema", () => {
    const constrained = constrainRoleOutputSchema(REVIEW_SCHEMA, CONSTRAINTS);
    assert.equal(REVIEW_SCHEMA.properties.criterionCoverage.items?.properties?.criterionId.enum, undefined);
    assert.deepEqual(constrained.properties.criterionCoverage.items?.properties?.criterionId.enum, ["c1", "c2"]);
    assert.deepEqual(constrained.properties.criterionCoverage.items?.properties?.evidenceIds.items?.enum, ["ev-source", "ev-artifact"]);
    assert.deepEqual(constrained.properties.findings.items?.properties?.evidenceRefs.items?.enum, ["ev-source", "ev-artifact"]);
    assert.deepEqual(constrained.properties.artifacts.items?.properties?.uri.enum, ["outputs/result.md"]);
  });

  it("rejects invented criterion, evidence, and artifact references before accepting exact values", async () => {
    const state = { reported: new Set<string>(), activeRole: new Map<string, string>(), payloads: new Map() };
    const tool = makeReportTool({ state, schema: constrainRoleOutputSchema(REVIEW_SCHEMA, CONSTRAINTS), failedStep: "goal-reviewer" });

    const badCriterion = await tool.execute("bad-c", payload({
      criterionCoverage: [{ criterionId: "dc-verify", status: "satisfied", evidenceIds: ["ev-source"] }],
    }), undefined, undefined, {} as never);
    assert.equal((badCriterion.details as any)?.errorType, "schema_mismatch");
    assert.match((badCriterion.details as any)?.message ?? "", /criterionId/);

    const badEvidence = await tool.execute("bad-e", payload({
      criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceIds: ["manual verification output"] }],
    }), undefined, undefined, {} as never);
    assert.equal((badEvidence.details as any)?.errorType, "schema_mismatch");
    assert.match((badEvidence.details as any)?.message ?? "", /evidenceIds/);

    const badArtifact = await tool.execute("bad-a", payload({
      artifacts: [{ uri: "/tmp/result.md", digest: "a".repeat(64), sizeBytes: 12 }],
    }), undefined, undefined, {} as never);
    assert.equal((badArtifact.details as any)?.errorType, "schema_mismatch");
    assert.match((badArtifact.details as any)?.message ?? "", /artifacts/);

    const accepted = await tool.execute("ok", payload(), undefined, undefined, {} as never);
    assert.match((accepted.content[0] as any).text, /report accepted/);
    assert.equal(state.reported.size, 1);
  });

  it("adds exact runtime constraints to the child task", () => {
    const task = appendRoleResultConstraints("Review the candidate.", CONSTRAINTS);
    assert.match(task, /Runtime-enforced structured result constraints/);
    assert.match(task, /\["c1","c2"\]/);
    assert.match(task, /\["ev-source","ev-artifact"\]/);
    assert.match(task, /\["outputs\/result.md"\]/);
  });
});
