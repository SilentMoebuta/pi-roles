import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { validateReport, buildStructuredError, type ReportSchema, type StructuredError } from "./contract";

// ponytail: per-session keying. reported is a Set of session keys that have
// already reported; activeRole binds a role name to a session key for accurate
// failedStep attribution. Keyed by session file path (falls back to session id,
// then "default") so a long-lived runtime serving multiple role sessions does
// not block the second reporter as a duplicate. Reset is implicit: a fresh
// session key is never in the set.
export interface ReportState {
  reported: Set<string>;
  activeRole: Map<string, string>;
}

export interface ReportToolOptions {
  state: ReportState;
  schema: ReportSchema;
  failedStep: string; // fallback role/step id when no active role is bound for this session
}

const Params = Type.Object({
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
  return defineTool({
    name: "report_role_result",
    label: "Report Role Result",
    description: "Report the structured result of this role's work. MUST be called exactly once before finishing.",
    parameters: Params,
    async execute(_toolCallId: string, params: Static<typeof Params>, _signal, _onUpdate, ctx) {
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
      return okResult("[pi-roles] report accepted. You may now stop.");
    },
  });
}
