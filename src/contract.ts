export type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null";

export interface ReportSchema {
  type: "object";
  required: string[];
  properties: Record<string, { type: JsonType }>;
}

export interface ReportPayload { [k: string]: unknown; }

export interface ValidationResult { ok: boolean; error?: string; }

export function validateReport(payload: ReportPayload, schema: ReportSchema): ValidationResult {
  if (typeof payload !== "object" || payload === null) return { ok: false, error: "payload not an object" };
  for (const key of schema.required) {
    if (!(key in payload)) return { ok: false, error: `missing required field: ${key}` };
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (key in payload) {
      const v = payload[key];
      const t = Array.isArray(v) ? "array" : (v === null ? "null" : typeof v);
      if (t !== prop.type) return { ok: false, error: `field ${key} expected ${prop.type}, got ${t}` };
    }
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
