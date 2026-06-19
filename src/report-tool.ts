import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { validateReport, buildStructuredError, type ReportSchema, type StructuredError } from "./contract";

export interface ReportState { reported: boolean; }

export interface ReportToolOptions {
  state: ReportState;
  schema: ReportSchema;
  failedStep: string; // role name / step id, for structured error attribution
}

const Params = Type.Object({
  findings: Type.Array(Type.String()),
  artifacts: Type.Array(Type.String(), { description: "file paths produced" }),
});

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
function errResult(e: StructuredError) {
  // Embed the structured error as JSON in content text so the caller (and tests) can parse it.
  return { content: [{ type: "text" as const, text: JSON.stringify(e) }], details: e };
}

export function makeReportTool(opts: ReportToolOptions) {
  return defineTool({
    name: "report_role_result",
    label: "Report Role Result",
    description: "Report the structured result of this role's work. MUST be called exactly once before finishing.",
    parameters: Params,
    async execute(_toolCallId: string, params: Static<typeof Params>, _signal, _onUpdate, _ctx) {
      if (opts.state.reported) {
        return errResult(buildStructuredError({
          failedStep: opts.failedStep,
          errorType: "duplicate_report",
          message: "report_role_result already called; this tool must be called exactly once.",
        }));
      }
      const v = validateReport(params as unknown as Record<string, unknown>, opts.schema);
      if (!v.ok) {
        return errResult(buildStructuredError({
          failedStep: opts.failedStep,
          errorType: "schema_mismatch",
          message: v.error ?? "validation failed",
        }));
      }
      opts.state.reported = true;
      return okResult("[pi-roles] report accepted. You may now stop.");
    },
  });
}
