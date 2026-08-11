import type { ReportPropertySchema, ReportSchema } from "../contract";

export interface RoleResultConstraints {
  criterionIds?: string[];
  evidenceIds?: string[];
  artifactUris?: string[];
}

function cloneProperty(schema: ReportPropertySchema): ReportPropertySchema {
  return {
    ...schema,
    ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
    ...(schema.items === undefined ? {} : { items: cloneProperty(schema.items) }),
    ...(schema.required === undefined ? {} : { required: [...schema.required] }),
    ...(schema.properties === undefined ? {} : {
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, cloneProperty(value)]),
      ),
    }),
  };
}

function cloneSchema(schema: ReportSchema): ReportSchema {
  return {
    type: "object",
    required: [...schema.required],
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, cloneProperty(value)]),
    ),
  };
}

function normalized(values: string[] | undefined, path: string): string[] | undefined {
  if (values === undefined) return undefined;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must contain non-empty strings`);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  if (unique.length === 0) throw new Error(`${path} must contain at least one value`);
  return unique;
}

function objectProperty(schema: ReportPropertySchema | undefined, path: string): ReportPropertySchema {
  if (!schema || schema.type !== "object" || !schema.properties) {
    throw new Error(`${path} is not available in this role output schema`);
  }
  return schema;
}

function arrayItem(schema: ReportPropertySchema | undefined, path: string): ReportPropertySchema {
  if (!schema || schema.type !== "array" || !schema.items) {
    throw new Error(`${path} is not available in this role output schema`);
  }
  return schema.items;
}

function setEnum(schema: ReportPropertySchema | undefined, values: string[], path: string): void {
  if (!schema || schema.type !== "string") throw new Error(`${path} is not a string in this role output schema`);
  schema.enum = values;
}

export function constrainRoleOutputSchema(
  schema: ReportSchema,
  constraints: RoleResultConstraints | undefined,
): ReportSchema {
  if (!constraints) return schema;
  const criterionIds = normalized(constraints.criterionIds, "resultConstraints.criterionIds");
  const evidenceIds = normalized(constraints.evidenceIds, "resultConstraints.evidenceIds");
  const artifactUris = normalized(constraints.artifactUris, "resultConstraints.artifactUris");
  if (!criterionIds && !evidenceIds && !artifactUris) return schema;

  const constrained = cloneSchema(schema);
  if (criterionIds) {
    const coverage = objectProperty(
      arrayItem(constrained.properties.criterionCoverage, "criterionCoverage"),
      "criterionCoverage[]",
    );
    setEnum(coverage.properties?.criterionId, criterionIds, "criterionCoverage[].criterionId");
  }
  if (evidenceIds) {
    const coverage = objectProperty(
      arrayItem(constrained.properties.criterionCoverage, "criterionCoverage"),
      "criterionCoverage[]",
    );
    const coverageEvidence = arrayItem(coverage.properties?.evidenceIds, "criterionCoverage[].evidenceIds");
    setEnum(coverageEvidence, evidenceIds, "criterionCoverage[].evidenceIds[]");

    if (constrained.properties.findings) {
      const finding = objectProperty(arrayItem(constrained.properties.findings, "findings"), "findings[]");
      if (finding.properties?.evidenceRefs) {
        const findingEvidence = arrayItem(finding.properties.evidenceRefs, "findings[].evidenceRefs");
        setEnum(findingEvidence, evidenceIds, "findings[].evidenceRefs[]");
      }
    }
  }
  if (artifactUris) {
    const artifact = objectProperty(arrayItem(constrained.properties.artifacts, "artifacts"), "artifacts[]");
    setEnum(artifact.properties?.uri, artifactUris, "artifacts[].uri");
  }
  return constrained;
}

export function appendRoleResultConstraints(
  task: string,
  constraints: RoleResultConstraints | undefined,
): string {
  if (!constraints) return task;
  const criterionIds = normalized(constraints.criterionIds, "resultConstraints.criterionIds");
  const evidenceIds = normalized(constraints.evidenceIds, "resultConstraints.evidenceIds");
  const artifactUris = normalized(constraints.artifactUris, "resultConstraints.artifactUris");
  const lines: string[] = [];
  if (criterionIds) lines.push(`- criterionCoverage[].criterionId: ${JSON.stringify(criterionIds)}`);
  if (evidenceIds) {
    lines.push(`- criterionCoverage[].evidenceIds[] and findings[].evidenceRefs[]: ${JSON.stringify(evidenceIds)}`);
  }
  if (artifactUris) lines.push(`- artifacts[].uri: ${JSON.stringify(artifactUris)}`);
  if (lines.length === 0) return task;
  return task + "\n\nRuntime-enforced structured result constraints (use only these exact values):\n" + lines.join("\n");
}
