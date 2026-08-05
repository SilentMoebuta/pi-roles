import {
  DEFAULT_REPORT_SCHEMA,
  type ReportPropertySchema,
  type ReportSchema,
} from "../contract";

const DISPATCH_SEND_SCHEMA: ReportPropertySchema = {
  type: "object",
  required: ["key", "role", "arg", "expected_output", "consumers"],
  properties: {
    key: { type: "string" },
    role: { type: "string" },
    arg: { type: "any" },
    expected_output: { type: "string" },
    consumers: { type: "array", items: { type: "string" } },
  },
};

/** Add the structured Send[] field required from a spawned result dispatcher. */
export function withDispatchField(schema: ReportSchema | undefined, maxChildren: number): ReportSchema {
  const base = schema ?? DEFAULT_REPORT_SCHEMA;
  return {
    type: "object",
    required: base.required.includes("sends") ? [...base.required] : [...base.required, "sends"],
    properties: {
      ...base.properties,
      sends: { type: "array", items: DISPATCH_SEND_SCHEMA, maxItems: maxChildren },
    },
  };
}

export function withDispatchTaskSuffix(task: string, maxChildren: number): string {
  return `${task}\n\n[result dispatch contract] This node chooses independent child work. In report_role_result, you MUST include a top-level "sends" array with at most ${maxChildren} items. Each item MUST contain a stable unique "key", a registered "role", a non-empty "arg" child task (string or object), a concrete "expected_output", and "consumers": ["$parent"]. Return an empty array when no child work is needed.`;
}

export function resolveDispatchContract(opts: {
  outputSchema?: ReportSchema;
  task: string;
  maxChildren?: number;
}): { schema: ReportSchema; task: string } {
  if (opts.maxChildren === undefined) {
    return { schema: opts.outputSchema ?? DEFAULT_REPORT_SCHEMA, task: opts.task };
  }
  return {
    schema: withDispatchField(opts.outputSchema, opts.maxChildren),
    task: withDispatchTaskSuffix(opts.task, opts.maxChildren),
  };
}
