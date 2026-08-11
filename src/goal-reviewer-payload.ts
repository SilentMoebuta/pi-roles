/** Canonical model-facing payload returned by the goal-reviewer role. */

export const GOAL_REVIEWER_PAYLOAD_SCHEMA_ID = "https://silentmoebuta.github.io/pi-roles/schemas/goal-reviewer-payload-v1.schema.json";

export type GoalReviewerDecisionV1 = "accept" | "revise" | "blocked";
export type GoalReviewerCriterionStatusV1 = "satisfied" | "unsatisfied" | "blocked";

export interface GoalReviewerCriterionCoverageV1 {
	criterionId: string;
	status: GoalReviewerCriterionStatusV1;
	evidenceIds: string[];
}

export interface GoalReviewerFindingV1 {
	id: string;
	code: string;
	severity: string;
	subjectId: string;
	reason: string;
	evidenceRefs: string[];
	missingEvidenceKind?: string;
}

export interface GoalReviewerArtifactV1 {
	uri: string;
	digest: string;
	sizeBytes: number;
}

export interface GoalReviewerPayloadV1 {
	decision: GoalReviewerDecisionV1;
	summary: string;
	criterionCoverage: GoalReviewerCriterionCoverageV1[];
	findings: GoalReviewerFindingV1[];
	artifacts: GoalReviewerArtifactV1[];
	advisories: string[];
}

const DECISIONS = ["accept", "revise", "blocked"] as const;
const COVERAGE_STATUSES = ["satisfied", "unsatisfied", "blocked"] as const;

/** Parse and normalize a reviewer payload according to the published V1 contract. */
export function parseGoalReviewerPayload(value: unknown): GoalReviewerPayloadV1 {
	const object = asRecord(value, "reviewer payload");
	assertKnownKeys(object, ["decision", "summary", "criterionCoverage", "findings", "artifacts", "advisories"], "reviewer payload");
	const decision = enumValue(object.decision, DECISIONS, "decision");
	const summary = requiredString(object.summary, "summary");
	const criterionCoverage = objectArray(object.criterionCoverage, "criterionCoverage").map((item, index) => {
		const itemPath = `criterionCoverage[${index}]`;
		assertKnownKeys(item, ["criterionId", "status", "evidenceIds"], itemPath);
		return {
			criterionId: requiredString(item.criterionId, `${itemPath}.criterionId`),
			status: enumValue(item.status, COVERAGE_STATUSES, `${itemPath}.status`),
			evidenceIds: stringArray(item.evidenceIds, `${itemPath}.evidenceIds`),
		};
	});
	const findings = objectArray(object.findings, "findings").map((item, index) => {
		const itemPath = `findings[${index}]`;
		assertKnownKeys(item, ["id", "code", "severity", "subjectId", "reason", "evidenceRefs", "missingEvidenceKind"], itemPath);
		const missingEvidenceKind = optionalString(item.missingEvidenceKind, `${itemPath}.missingEvidenceKind`);
		return {
			id: requiredString(item.id, `${itemPath}.id`),
			code: requiredString(item.code, `${itemPath}.code`),
			severity: requiredString(item.severity, `${itemPath}.severity`),
			subjectId: requiredString(item.subjectId, `${itemPath}.subjectId`),
			reason: requiredString(item.reason, `${itemPath}.reason`),
			evidenceRefs: stringArray(item.evidenceRefs, `${itemPath}.evidenceRefs`),
			...(missingEvidenceKind === undefined ? {} : { missingEvidenceKind }),
		};
	});
	const artifacts = objectArray(object.artifacts, "artifacts").map((item, index) => {
		const itemPath = `artifacts[${index}]`;
		assertKnownKeys(item, ["uri", "digest", "sizeBytes"], itemPath);
		return {
			uri: requiredString(item.uri, `${itemPath}.uri`),
			digest: digestValue(item.digest, `${itemPath}.digest`),
			sizeBytes: nonNegativeInteger(item.sizeBytes, `${itemPath}.sizeBytes`),
		};
	});
	const advisories = object.advisories === undefined ? [] : stringArray(object.advisories, "advisories");
	return { decision, summary, criterionCoverage, findings, artifacts, advisories };
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(object)) {
		if (!allowedSet.has(key)) throw new Error(`${path} contains unknown property ${key}`);
	}
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${path} must be a string`);
	return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
	return value as T[number];
}

function objectArray(value: unknown, path: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((item, index) => asRecord(item, `${path}[${index}]`));
}

function stringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function digestValue(value: unknown, path: string): string {
	const supplied = requiredString(value, path);
	const digest = supplied.startsWith("sha256:") ? supplied.slice("sha256:".length) : supplied;
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${path} must be a lowercase sha256 digest`);
	return digest;
}

function nonNegativeInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
	return value;
}
