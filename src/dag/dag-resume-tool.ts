// dag_resume tool — resumes a DAG from a serialized checkpoint (Phase 5e exposure).
// The library (checkpoint.ts) already ships serialize/deserialize/makeCheckpoint/
// resumeDAG; this tool is the agent-facing entry point. Accepts a JSON checkpoint
// (produced by serializeCheckpoint after a partial run) and resumes it with the
// real SubagentsService via the same SpawnFn adapter as dag_execute.
//
// Gap P4 — before this, checkpoint/resume was library-complete but agent-invisible.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deserializeCheckpoint, resumeDAG } from "./checkpoint";
import type { DagExecuteDeps } from "./dag-execute-tool";
import { buildSpawnFn } from "./dag-execute-tool";

const Params = Type.Object({
  checkpoint: Type.String({ description: "Serialized DAG checkpoint (JSON from serializeCheckpoint)." }),
  maxConcurrent: Type.Optional(Type.Number({ description: "Max concurrent spawns per wave (default 5)." })),
});

export function makeDagResumeTool(deps: DagExecuteDeps) {
  return defineTool({
    name: "dag_resume",
    label: "Resume DAG",
    description: "Resume a DAG from a serialized checkpoint — skip already-completed waves and continue with prior results preserved.",
    parameters: Params,
    async execute(_toolCallId: string, params: { checkpoint: string; maxConcurrent?: number }, signal, _onUpdate, _ctx) {
      const cp = deserializeCheckpoint(params.checkpoint);
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
      const result = await resumeDAG(cp, spawnFn);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
