import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	GOAL_REVIEWER_PAYLOAD_SCHEMA_ID,
	parseGoalReviewerPayload,
} from "../src/goal-reviewer-payload";

const digest = "a".repeat(64);

function validPayload() {
	return {
		decision: "accept",
		summary: "All blocking criteria are evidenced.",
		criterionCoverage: [{ criterionId: "c1", status: "satisfied", evidenceIds: ["e1"] }],
		findings: [{ id: "f1", code: "note", severity: "low", subjectId: "c1", reason: "Clear.", evidenceRefs: ["e1"] }],
		artifacts: [{ uri: "result.md", digest, sizeBytes: 12 }],
		advisories: [],
	};
}

describe("canonical goal-reviewer payload protocol", () => {
	it("parses the published payload and normalizes sha256 transport spelling", () => {
		const payload = validPayload();
		payload.artifacts[0].digest = `sha256:${digest}`;
		assert.deepEqual(parseGoalReviewerPayload(payload), { ...payload, artifacts: [{ ...payload.artifacts[0], digest }] });
		assert.match(GOAL_REVIEWER_PAYLOAD_SCHEMA_ID, /goal-reviewer-payload-v1/);
	});

	it("allows findings with evidence references and no missing-evidence marker", () => {
		assert.equal(parseGoalReviewerPayload(validPayload()).findings[0].missingEvidenceKind, undefined);
	});

	it("rejects malformed payloads and unknown properties", () => {
		assert.throws(() => parseGoalReviewerPayload({ ...validPayload(), summary: "" }), /summary/);
		assert.throws(() => parseGoalReviewerPayload({ ...validPayload(), unexpected: true }), /unknown property/);
		assert.throws(() => parseGoalReviewerPayload({ ...validPayload(), artifacts: [{ uri: "x", digest: "bad", sizeBytes: 1 }] }), /sha256 digest/);
	});
});
