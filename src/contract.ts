export type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null" | "any";

export interface ReportPropertySchema {
  type: JsonType;
  /** Optional recursive schema used by generated contracts such as result-driven
   * DAG dispatch. Existing array schemas omit this and retain legacy behavior. */
  items?: ReportPropertySchema;
  properties?: Record<string, ReportPropertySchema>;
  required?: string[];
  maxItems?: number;
}

export interface ReportSchema {
  type: "object";
  required: string[];
  properties: Record<string, ReportPropertySchema>;
}

export interface ReportPayload { [k: string]: unknown; }

export interface ValidationResult { ok: boolean; error?: string; }

function valueType(value: unknown): JsonType | "undefined" | "function" | "symbol" | "bigint" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateValue(value: unknown, schema: ReportPropertySchema, path: string): string | undefined {
  const actual = valueType(value);
  if (schema.type !== "any" && actual !== schema.type) {
    return `field ${path} expected ${schema.type}, got ${actual}`;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `field ${path} must contain at most ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateValue(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) return `missing required field: ${path}.${key}`;
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) continue;
      const error = validateValue(record[key], property, `${path}.${key}`);
      if (error) return error;
    }
  }
  return undefined;
}

export function validateReport(payload: ReportPayload, schema: ReportSchema): ValidationResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, error: "payload not an object" };
  }
  for (const key of schema.required) {
    if (!(key in payload)) return { ok: false, error: `missing required field: ${key}` };
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in payload)) continue;
    const error = validateValue(payload[key], prop, key);
    if (error) return { ok: false, error };
  }
  return { ok: true };
}

export interface StructuredError {
  failedStep: string;
  errorType: string;
  message: string;
  timestamp: number;
}

export function buildStructuredError(e: Omit<StructuredError, "timestamp">): StructuredError {
  return { ...e, timestamp: Date.now() };
}

// ponytail: default schema shared by report tool (B4) and tests; required by B4 Step 5.
export const DEFAULT_REPORT_SCHEMA: ReportSchema = {
  type: "object",
  required: ["findings", "artifacts"],
  properties: { findings: { type: "array" }, artifacts: { type: "array" } },
};
