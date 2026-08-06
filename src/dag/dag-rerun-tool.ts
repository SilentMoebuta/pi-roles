// dag_rerun tool — re-execute part of a finished/failed DAG from its
// checkpoint, reusing untouched node results. Forms:
//   B: rerunNodes (explicit nodes + downstream closure, inject feedback)
//   C: specPatch (add/remove/modify nodes, keep untouched results)
// Mirrors Dagster FROM_FAILURE re-execution and GitHub Actions rerun
// ("a job and its dependent jobs"). Defaults to rerunning failed nodes.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deserializeCheckpoint, makeCheckpointV2, serializeCheckpoint, type DAGCheckpointV2 } from "./checkpoint";
import { executeDAGCore } from "./executor";
import { buildSpawnFn, type DagExecuteDeps } from "./dag-execute-tool";
import { makeOnProgress } from "./progress";
import { buildRerunView, type DagRerunOptions } from "./rerun";
import { validateDAG } from "./validate";

const Params = Type.Object({
  checkpoint: Type.String({ description: "Serialized DAG checkpoint (JSON from serializeCheckpoint of a finished or partial run)." }),
  rerunNodes: Type.Optional(Type.Array(Type.String(), { description: "Node ids to rerun together with their downstream closure. Defaults to all failed nodes (FROM_FAILURE). Empty array reruns nothing and reuses every result." })),
  inject: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Failure/verification feedback injected into each rerun node's task (keyed by node id)." })),
  specPatch: Type.Optional(Type.Object({
    add: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "New nodes keyed by id (task + optional role/depends_on/contract)." })),
    remove: Type.Optional(Type.Array(Type.String(), { description: "Node ids to remove along with their incoming edges." })),
    modify: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Field-level overrides per existing node id (role, task, depends_on, model, timeout_ms...)." })),
  }, { description: "Structural changes (form C): untouched node results are reused." })),
  maxConcurrent: Type.Optional(Type.Number({ description: "Maximum DAG nodes running at once (default 5)." })),
  scheduler: Type.Optional(Type.Union([Type.Literal("wave"), Type.Literal("ready")], { description: "Scheduler override. Defaults to the checkpoint's." })),
});

export function makeDagRerunTool(deps: DagExecuteDeps) {
  return defineTool({
    name: "dag_rerun",
    label: "Rerun DAG",
    description: "Re-execute part of a DAG from its checkpoint: rerun specific nodes (with their downstream closure) or apply structural changes (add/remove/modify nodes), reusing untouched node results. Inject failure feedback into rerun node tasks. For verification failures prefer dag_rerun over patching files directly in the main session.",
    parameters: Params,
    async execute(_toolCallId: string, params: {
      checkpoint: string;
      rerunNodes?: string[];
      inject?: Record<string, string>;
      specPatch?: DagRerunOptions["specPatch"];
      maxConcurrent?: number;
      scheduler?: "wave" | "ready";
    }, signal, onUpdate, _ctx) {
      const deserialized = deserializeCheckpoint(params.checkpoint);
      if (!("version" in deserialized) || deserialized.version !== 2) {
        return { content: [{ type: "text" as const, text: "dag_rerun requires a V2 checkpoint (from dag_execute or dag_resume)." }], isError: true, details: {} };
      }
      const cp: DAGCheckpointV2 = deserialized;
      const view = buildRerunView(cp, {
        rerunNodes: params.rerunNodes,
        inject: params.inject,
        specPatch: params.specPatch,
      });
      if ("errors" in view) {
        const details = { status: "error", errors: view.errors };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], isError: true, details };
      }
      const validation = validateDAG(view.spec, deps.roleRegistry, {
        expandedDispatches: new Set(Object.keys(view.initialDispatchExpansions)),
      });
      if (!validation.ok) {
        const details = { status: "error", errors: validation.errors, admissionDiagnostics: validation.diagnostics };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], isError: true, details };
      }

      const ctx = _ctx;
      const spawnFn = buildSpawnFn(deps, {
        modelRegistry: ctx?.modelRegistry,
        signal,
        getCallerSessionFile: () => ctx?.sessionManager?.getSessionFile?.(),
      });
      const onProgress = onUpdate ? makeOnProgress(view.spec, onUpdate) : undefined;
      let latestCheckpoint: DAGCheckpointV2 | undefined;
      const result = await executeDAGCore(view.spec, spawnFn, {
        maxConcurrent: params.maxConcurrent,
        scheduler: params.scheduler ?? cp.scheduler,
        knownRoles: deps.roleRegistry,
        signal,
        onProgress,
        onCheckpoint: (snapshot) => { latestCheckpoint = makeCheckpointV2(cp.spec, snapshot); },
        initialNodeResults: view.initialNodeResults,
        initialNodeStates: view.initialNodeStates,
        initialSkipReasons: view.initialSkipReasons,
        initialGeneratedNodes: view.initialGeneratedNodes,
        initialDispatchExpansions: view.initialDispatchExpansions,
        initialNodeModes: view.initialNodeModes,
      });
      const details = latestCheckpoint
        ? { ...result, rerunClosure: view.rerunClosure, checkpoint: serializeCheckpoint(latestCheckpoint) }
        : { ...result, rerunClosure: view.rerunClosure };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  });
}
