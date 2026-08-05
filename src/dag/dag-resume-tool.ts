// dag_resume tool — resumes a DAG from a serialized checkpoint (Phase 5e exposure).
// The library (checkpoint.ts) already ships serialize/deserialize/makeCheckpoint/
// resumeDAG; this tool is the agent-facing entry point. Accepts a JSON checkpoint
// (produced by serializeCheckpoint after a partial run) and resumes it with the
// real SubagentsService via the same SpawnFn adapter as dag_execute.
//
// Gap P4 — before this, checkpoint/resume was library-complete but agent-invisible.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deserializeCheckpoint, makeCheckpointV2, resumeDAG, serializeCheckpoint, type DAGCheckpointV2 } from "./checkpoint";
import type { DagExecuteDeps } from "./dag-execute-tool";
import { buildSpawnFn } from "./dag-execute-tool";
import { makeOnProgress } from "./progress";
import { validateDAG } from "./validate";

const Params = Type.Object({
  checkpoint: Type.String({ description: "Serialized DAG checkpoint (JSON from serializeCheckpoint)." }),
  maxConcurrent: Type.Optional(Type.Number({ description: "Maximum DAG nodes running at once (default 5)." })),
  scheduler: Type.Optional(Type.Union([Type.Literal("wave"), Type.Literal("ready")], { description: "Optional override. Without it, V2 uses its checkpoint scheduler and V1 defaults to ready." })),
});

export function makeDagResumeTool(deps: DagExecuteDeps) {
  return defineTool({
    name: "dag_resume",
    label: "Resume DAG",
    description: "Resume a DAG from a V1 wave checkpoint or V2 explicit-node checkpoint without replaying completed work.",
    parameters: Params,
    async execute(_toolCallId: string, params: { checkpoint: string; maxConcurrent?: number; scheduler?: "wave" | "ready" }, signal, onUpdate, _ctx) {
      const cp = deserializeCheckpoint(params.checkpoint);
      const resumeSpec = "version" in cp && cp.version === 2 ? cp.expandedSpec : cp.spec;
      const validation = validateDAG(resumeSpec, deps.roleRegistry, {
        expandedDispatches: new Set("version" in cp && cp.version === 2 ? Object.keys(cp.dispatchExpansions) : []),
      });
      if (!validation.ok) {
        const details = { status: "error", errors: validation.errors, admissionDiagnostics: validation.diagnostics };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
      // C4 fix (HIGH): build spawnFn INSIDE execute with the tool AbortSignal +
      // ctx.modelRegistry + caller sessionFile — parity with dag_execute (T1-4).
      // Previously built ONCE at registration with NO opts → resumed children got
      // no model resolution, no abort forwarding, no tree-abort membership (silent
      // functional regression; the old test's fake service didn't track these).
      const ctx = _ctx as any;
      const spawnFn = buildSpawnFn(deps, {
        modelRegistry: ctx?.modelRegistry,
        signal,
        getCallerSessionFile: () => ctx?.sessionManager?.getSessionFile?.(),
      });
      const onProgress = onUpdate ? makeOnProgress(resumeSpec, onUpdate) : undefined;
      let latestCheckpoint: DAGCheckpointV2 | undefined;
      const result = await resumeDAG(cp, spawnFn, {
        maxConcurrent: params.maxConcurrent,
        scheduler: params.scheduler,
        knownRoles: deps.roleRegistry,
        signal,
        onProgress,
        onCheckpoint: (snapshot) => { latestCheckpoint = makeCheckpointV2(cp.spec, snapshot); },
      });
      const details = latestCheckpoint
        ? { ...result, checkpoint: serializeCheckpoint(latestCheckpoint) }
        : result;
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}
