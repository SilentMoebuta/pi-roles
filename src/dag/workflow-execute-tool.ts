import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildSpawnFn, DAGRetryPolicyParams, makeDagExecuteTool, type DagExecuteDeps } from "./dag-execute-tool";
import { executeBoundedWorkflowLoop, compileWorkflowToDAG, validateWorkflowContract, type WorkflowContractV1 } from "./workflow-contract";
import { classifyDAGError } from "./error-taxonomy";
import type { DAGAttemptEvent, DAGRetryPolicy } from "./executor-contract";
import type { DAGNodeError } from "./types";

const WorkflowTask = Type.Object({
  id: Type.String(),
  task: Type.String(),
  role: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  expectedOutput: Type.Optional(Type.String()),
  resourceScope: Type.Optional(Type.Array(Type.String())),
});

const Params = Type.Object({
  workflow: Type.Object({
    schemaVersion: Type.Literal(1),
    id: Type.String(),
    kind: Type.Union([
      Type.Literal("direct"), Type.Literal("sequential"), Type.Literal("parallel"),
      Type.Literal("conditional"), Type.Literal("loop"), Type.Literal("map_reduce"),
      Type.Literal("handoff"), Type.Literal("dag"),
    ]),
    tasks: Type.Array(WorkflowTask),
    condition: Type.Optional(Type.Object({ routerId: Type.String(), routes: Type.Record(Type.String(), Type.Array(Type.String())) })),
    loop: Type.Optional(Type.Object({ maxIterations: Type.Integer({ minimum: 1, maximum: 100 }), until: Type.String() })),
  mapReduce: Type.Optional(Type.Object({
      items: Type.Array(Type.Object({ key: Type.String(), input: Type.String() })),
      mapRole: Type.Optional(Type.String()), mapTask: Type.String(), reduceTaskId: Type.String(),
  })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
  scheduler: Type.Optional(Type.Union([Type.Literal("wave"), Type.Literal("ready")])),
  retryPolicy: Type.Optional(DAGRetryPolicyParams),
});

/** Agent-facing adapter for every P2 workflow kind. */
export function makeWorkflowExecuteTool(deps: DagExecuteDeps) {
  const dagTool = makeDagExecuteTool(deps) as any;
  return defineTool({
    name: "workflow_execute",
    label: "Execute Workflow",
    description: "Execute a direct, sequential, parallel, conditional, bounded loop, map/reduce, handoff, or DAG workflow through the shared pi-roles runtime. Workflow state and errors use the same DAG/checkpoint contract.",
    parameters: Params,
    async execute(toolCallId: string, params: { workflow: WorkflowContractV1; maxConcurrent?: number; scheduler?: "wave" | "ready"; retryPolicy?: Partial<DAGRetryPolicy> }, signal: AbortSignal, onUpdate: (update: unknown) => void, ctx: any) {
      const validation = validateWorkflowContract(params.workflow);
      if (!validation.ok) {
        const details = { status: "error", errors: validation.errors };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
      if (params.workflow.kind !== "loop") {
        const spec = compileWorkflowToDAG(params.workflow);
        return dagTool.execute(toolCallId, { spec, maxConcurrent: params.maxConcurrent, scheduler: params.scheduler, retryPolicy: params.retryPolicy }, signal, onUpdate, ctx);
      }

      const spawn = buildSpawnFn(deps, {
        modelRegistry: ctx?.modelRegistry,
        signal,
        getCallerSessionFile: () => ctx?.sessionManager?.getSessionFile?.(),
      });
      const attempts: DAGAttemptEvent[] = [];
      const retryPolicy = {
        maxAttempts: Math.max(1, Math.floor(params.retryPolicy?.maxAttempts ?? 1)),
        baseDelayMs: Math.max(0, Math.floor(params.retryPolicy?.baseDelayMs ?? 10_000)),
        maxDelayMs: Math.max(0, Math.floor(params.retryPolicy?.maxDelayMs ?? 120_000)),
      };
      try {
        const result = await executeBoundedWorkflowLoop(params.workflow, async ({ iteration, previous, task, until }) => {
          const nodeId = `${task.id}:iteration:${iteration}`;
          for (let attemptNumber = 1; attemptNumber <= retryPolicy.maxAttempts; attemptNumber++) {
            attempts.push({ nodeId, attemptNumber, status: "started" });
            let error: DAGNodeError;
            try {
              const child = await spawn(task.role, `${task.task}\n\n[loop contract] Iteration ${iteration}; previous result: ${JSON.stringify(previous ?? null)}. Stop only when the '${until}' condition is satisfied and report a top-level 'done' boolean.`, undefined, undefined, undefined, undefined, undefined);
              const settled = await child.wait();
              if (settled.status === "completed") {
                attempts.push({ nodeId, attemptNumber, status: "completed" });
                const payload = settled.result as Record<string, unknown> | undefined;
                return { value: payload ?? {}, done: payload?.done === true };
              }
              error = settled.errorInfo ?? classifyDAGError(settled.error ?? `loop iteration ${iteration} failed`, settled.status);
            } catch (caught) {
              error = classifyDAGError(caught);
            }
            if (!error.retryable || attemptNumber >= retryPolicy.maxAttempts || signal?.aborted) {
              attempts.push({ nodeId, attemptNumber, status: "failed", error });
              throw new Error(error.message);
            }
            const delayMs = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * (2 ** Math.max(0, attemptNumber - 1)));
            attempts.push({ nodeId, attemptNumber, status: "retrying", error, delayMs });
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (signal?.aborted) throw new Error("workflow execution aborted");
          }
          throw new Error(`loop iteration ${iteration} exhausted its retry policy`);
        });
        const details = { status: result.status, iterations: result.iterations, attempts };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        const details = { status: "failed", error: error instanceof Error ? error.message : String(error), attempts };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], isError: true, details };
      }
    },
  });
}
