import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildSpawnFn, type DagExecuteDeps } from "./dag-execute-tool";
import { classifyDAGError } from "./error-taxonomy";
import { executeBatchManifest, validateBatchManifest, type BatchAggregateResultV1, type BatchManifestV1 } from "./batch-runtime";

const Params = Type.Object({
  manifest: Type.Object({
    schemaVersion: Type.Literal(1),
    id: Type.String(),
    maxConcurrent: Type.Integer({ minimum: 1 }),
    tasks: Type.Array(Type.Object({
      id: Type.String(),
      runId: Type.String(),
      attemptId: Type.String(),
      spec: Type.Object({ task: Type.String(), role: Type.Optional(Type.String()) }),
      resourceScopes: Type.Optional(Type.Array(Type.String())),
    })),
  }),
  mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("failed_only")])),
  prior: Type.Optional(Type.Unknown()),
});

interface BatchSpawnSpec { task: string; role?: string; }
type BatchExecuteDetails = BatchAggregateResultV1 | { status: "error"; errors: string[] };

/** Agent-facing adapter for the generic batch runtime. */
export function makeBatchExecuteTool(deps: DagExecuteDeps) {
  return defineTool({
    name: "batch_execute",
    label: "Execute Batch",
    description: "Execute independent logical runs from a batch manifest with bounded concurrency, resource URI leases, separate run/attempt lineage, and failed-only retry.",
    parameters: Params,
		async execute(_toolCallId: string, params: { manifest: BatchManifestV1<BatchSpawnSpec>; mode?: "all" | "failed_only"; prior?: BatchAggregateResultV1 }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any): Promise<AgentToolResult<BatchExecuteDetails>> {
		const validationErrors = validateBatchManifest(params.manifest);
		if (validationErrors.length > 0) {
			const details = { status: "error" as const, errors: validationErrors };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		}
      const spawn = buildSpawnFn(deps, {
        modelRegistry: ctx?.modelRegistry,
        signal,
        getCallerSessionFile: () => ctx?.sessionManager?.getSessionFile?.(),
      });
		try {
			const aggregate = await executeBatchManifest(params.manifest, async (task) => {
				const child = await spawn(task.spec.role, task.spec.task);
				const settled = await child.wait();
				if (settled.status === "completed") return { status: "completed" as const, value: settled.result };
				if (settled.status === "aborted") return { status: "cancelled" as const, error: { code: "cancelled", message: settled.error ?? "batch child aborted", retryable: false } };
				const error = classifyDAGError(settled.error ?? "batch child failed");
				return { status: "failed" as const, error: { code: error.code, message: error.message, retryable: error.retryable } };
			}, { mode: params.mode, prior: params.prior, signal });
			const details = aggregate;
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		} catch (error) {
			const details = { status: "error" as const, errors: [error instanceof Error ? error.message : String(error)] };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		}
    },
  });
}
