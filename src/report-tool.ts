import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateReport, buildStructuredError, type ReportSchema, type StructuredError, type ReportPayload } from "./contract";

export type { ReportPayload };

// ponytail: per-session keying. reported is a Set of session keys that have
// already reported; activeRole binds a role name to a session key for accurate
// failedStep attribution; payloads stores the structured result a role reported,
// keyed by the role session's file — spawn_role reads it back as the structured
// handoff (decision 4旁路 Map: AgentSession tool results aren't in prompt()'s
// return, so the structured payload travels out-of-band via this map).
export interface ReportState {
  reported: Set<string>;
  activeRole: Map<string, string>;
  payloads: Map<string, ReportPayload>;
}

export interface ReportToolOptions {
  state: ReportState;
  schema: ReportSchema;
  failedStep: string; // fallback role/step id when no active role is bound for this session
}

// Build a TypeBox object schema from a ReportSchema so the LLM-facing tool
// parameters reflect the role's outputSchema (T1-3/P1-6). Previously hardcoded
// to {findings, artifacts}, which meant a role with a custom schema could
// NEVER get the LLM to call report_role_result with custom fields — the model
// only saw findings/artifacts. Mirrors DEFAULT_REPORT_SCHEMA when that's passed.
function schemaToTypeBox(schema: ReportSchema) {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    // ponytail: map our minimal JsonType to TypeBox primitives. 'array' without
    // an item type defaults to string[] (the default schema's shape).
    if (prop.type === "string") properties[key] = Type.String();
    else if (prop.type === "number") properties[key] = Type.Number();
    else if (prop.type === "boolean") properties[key] = Type.Boolean();
    else if (prop.type === "array") properties[key] = Type.Array(Type.String());
    else properties[key] = Type.Any(); // object/null/unknown
  }
  // Type.Object expects TProperties; our Record<string,TSchema> is structurally
  // compatible — cast through unknown to satisfy the type without a runtime change.
  return Type.Object(properties as any, { required: schema.required });
}

const DefaultParams = Type.Object({
  findings: Type.Array(Type.String()),
  artifacts: Type.Array(Type.String(), { description: "file paths produced" }),
});

// Resolve a stable per-session key from the tool execution context. Falls back
// to "default" when the session manager is unavailable (e.g. in direct unit
// tests) so behaviour degrades to a single shared slot rather than crashing.
function resolveSessionKey(ctx: unknown): string {
  const sm = (ctx as any)?.sessionManager;
  return sm?.getSessionFile?.() ?? sm?.getSessionId?.() ?? "default";
}

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
function errResult(e: StructuredError, terminate?: boolean) {
  // Embed the structured error as JSON in content text so the caller (and tests) can parse it.
  return { content: [{ type: "text" as const, text: JSON.stringify(e) }], details: e, terminate };
}

export function makeReportTool(opts: ReportToolOptions) {
  const Params = schemaToTypeBox(opts.schema);
  return defineTool({
    name: "report_role_result",
    label: "Report Role Result",
    description: "Report the structured result of this role's work. MUST be called exactly once before finishing.",
    parameters: Params,
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
      const sk = resolveSessionKey(ctx);
      const failedStep = opts.state.activeRole.get(sk) ?? opts.failedStep;
      if (opts.state.reported.has(sk)) {
        // Role already reported for this session; the role is done. Terminate so
        // the agent does not loop retrying a once-only contract.
        return errResult(buildStructuredError({
          failedStep,
          errorType: "duplicate_report",
          message: "report_role_result already called for this session; this tool must be called exactly once.",
        }), true);
      }
      const v = validateReport(params as unknown as Record<string, unknown>, opts.schema);
      if (!v.ok) {
        // Schema failure: leave terminate unset so the agent may retry with a corrected payload.
        return errResult(buildStructuredError({
          failedStep,
          errorType: "schema_mismatch",
          message: v.error ?? "validation failed",
        }));
      }
      opts.state.reported.add(sk);
      // Store the FULL validated payload (T1-3: was hardcoded to
      // {findings, artifacts}, discarding custom-schema data). Keys are dynamic
      // per the role's outputSchema, so store params wholesale.
      opts.state.payloads.set(sk, { ...params });
      return okResult("[pi-roles] report accepted. You may now stop.");
    },
  });
}
