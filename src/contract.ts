export type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null" | "any";

export interface ReportPropertySchema {
  type: JsonType;
  /** Literal values accepted for scalar properties. This subset is carried
   * into both the LLM-facing TypeBox contract and deterministic validation. */
  enum?: Array<string | number | boolean>;
  /** Optional ECMAScript regular expression for string values. */
  pattern?: string;
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

/** Parse a declarative role output schema from YAML/JSON frontmatter. */
export function parseReportSchema(value: unknown, path = "outputSchema"): ReportSchema | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const object = value as Record<string, unknown>;
  if (object.type !== "object") throw new Error(`${path}.type must be object`);
  if (!Array.isArray(object.required) || !object.required.every((item) => typeof item === "string")) {
    throw new Error(`${path}.required must be a string array`);
  }
  if (!object.properties || typeof object.properties !== "object" || Array.isArray(object.properties)) {
    throw new Error(`${path}.properties must be an object`);
  }
  const properties = Object.fromEntries(Object.entries(object.properties as Record<string, unknown>)
    .map(([key, property]) => [key, parseReportPropertySchema(property, `${path}.properties.${key}`)]));
  for (const required of object.required as string[]) {
    if (!(required in properties)) throw new Error(`${path}.required references unknown property ${required}`);
  }
  return { type: "object", required: [...object.required] as string[], properties };
}

function parseReportPropertySchema(value: unknown, path: string): ReportPropertySchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const object = value as Record<string, unknown>;
  const types: JsonType[] = ["string", "number", "boolean", "array", "object", "null", "any"];
  if (typeof object.type !== "string" || !types.includes(object.type as JsonType)) throw new Error(`${path}.type is invalid`);
  const type = object.type as JsonType;
  const enumValues = object.enum === undefined ? undefined : (() => {
    if (!Array.isArray(object.enum) || object.enum.length === 0
      || object.enum.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
      throw new Error(`${path}.enum must be a non-empty scalar array`);
    }
    const values = [...object.enum] as Array<string | number | boolean>;
    if (type !== "any" && values.some((item) => typeof item !== type)) {
      throw new Error(`${path}.enum values must match type ${type}`);
    }
    return values;
  })();
  const pattern = object.pattern === undefined ? undefined : (() => {
    if (type !== "string") throw new Error(`${path}.pattern is only valid for string properties`);
    if (typeof object.pattern !== "string" || !object.pattern) throw new Error(`${path}.pattern must be a non-empty string`);
    try { new RegExp(object.pattern); }
    catch { throw new Error(`${path}.pattern must be a valid regular expression`); }
    return object.pattern;
  })();
  const items = object.items === undefined ? undefined : parseReportPropertySchema(object.items, `${path}.items`);
  const required = object.required === undefined ? undefined : (() => {
    if (!Array.isArray(object.required) || !object.required.every((item) => typeof item === "string")) {
      throw new Error(`${path}.required must be a string array`);
    }
    return [...object.required] as string[];
  })();
  const properties = object.properties === undefined ? undefined : (() => {
    if (!object.properties || typeof object.properties !== "object" || Array.isArray(object.properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    return Object.fromEntries(Object.entries(object.properties as Record<string, unknown>)
      .map(([key, property]) => [key, parseReportPropertySchema(property, `${path}.properties.${key}`)]));
  })();
  const maxItems = object.maxItems === undefined ? undefined : (() => {
    if (typeof object.maxItems !== "number" || !Number.isInteger(object.maxItems) || object.maxItems < 0) {
      throw new Error(`${path}.maxItems must be a non-negative integer`);
    }
    return object.maxItems;
  })();
  return {
    type,
    ...(enumValues === undefined ? {} : { enum: enumValues }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(items === undefined ? {} : { items }),
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

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
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return `field ${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  if (schema.pattern && typeof value === "string" && !(new RegExp(schema.pattern).test(value))) {
    return `field ${path} must match pattern ${schema.pattern}`;
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
