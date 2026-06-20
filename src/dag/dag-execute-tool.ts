// dag_execute tool — the main agent's entry point for running a DAG spec.
// Bridges the gap between "planner produces a DAGSpec" and "executor runs it"
// by wrapping the SubagentsService in a SpawnFn adapter that applies per-node
// role resolution (childTools, skillsOverride, customTools for report_role_result,
// model/thinkingLevel resolution) — the same logic as spawn-role-tool.
//
// Gap A (Phase 5 production hardening): before this, executeDAG had no caller
// in the agent loop — it was a library tested only from code.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { executeDAGCore, type SpawnFn } from "./executor";
import { resolveModelRef } from "../subagent/spawn-role-tool";
import type { DAGSpec, NodePayload } from "./types";
import type { RoleDef } from "../roles";
import type { ReportState } from "../report-tool";
import { makeReportTool } from "../report-tool";
import { DEFAULT_REPORT_SCHEMA } from "../contract";
import { makeRoleSkillsOverride } from "../subagent/skills-override";
import type { SpawnToolService } from "../subagent/spawn-role-tool";

const Params = Type.Object({
  spec: Type.Object({
    nodes: Type.Record(Type.String(), Type.Object({
      role: Type.String(),
      task: Type.String(),
      depends_on: Type.Optional(Type.Array(Type.String())),
    })),
  }),
  maxConcurrent: Type.Optional(Type.Number({ description: "Max concurrent spawns per wave (default 5). Caps parallel createAgentSession calls to prevent resource exhaustion." })),
});

export interface DagExecuteDeps {
  roleRegistry: Map<string, RoleDef>;
  service: SpawnToolService;
  reportState: ReportState;
  cwd: string;
  agentDir: string;
}

// Build a SpawnFn adapter that applies per-node role resolution. For each DAG
// node, this mirrors spawn-role-tool's preamble: force-include report_role_result
// in childTools, inject skillsOverride resourceLoader + customTools, and resolve
// the role's model. The executor calls this once per node per wave.
// T1-4: now accepts {modelRegistry, signal, getCallerSessionFile} so the tool's
// AbortSignal + ctx.modelRegistry + caller sessionFile flow into each child
// (was: signal/model/parentSessionId all undefined → mid-DAG abort leaked
// children, role.model ignored, DAG nodes outside the tree-abort tree).
export interface BuildSpawnFnOpts {
  modelRegistry?: { getAll(): any[]; find(provider: string, id: string): any | undefined };
  signal?: AbortSignal;
  getCallerSessionFile?: () => string | undefined;
}
export function buildSpawnFn(deps: DagExecuteDeps, opts: BuildSpawnFnOpts = {}): SpawnFn {
  const { roleRegistry, service, cwd, agentDir } = deps;
  const { modelRegistry, signal, getCallerSessionFile } = opts;
  const _thisDir = path.dirname(fileURLToPath(import.meta.url));
  const roleSkillsDirs = ["researcher-skills", "planner-skills", "reviewer-skills", "coder-skills", "debugger-skills"];
  const allSkills: Skill[] = [];
  for (const d of roleSkillsDirs) {
    const dir = path.resolve(_thisDir, "..", "..", "roles", d);
    try {
      const { skills } = loadSkillsFromDir({ dir, source: "pi-roles-roles" });
      allSkills.push(...skills);
    } catch { /* no skills dir — skip */ }
  }

  return async (roleName, task) => {
    const role = roleRegistry.get(roleName);
    // If role unknown, spawn with defaults (service.spawn handles missing role gracefully).
    const childTools = role
      ? Array.from(new Set([...role.tools, "report_role_result"]))
      : ["read", "bash", "write", "edit", "grep", "find", "ls", "report_role_result"];

    const domainSkills: Skill[] = role
      ? allSkills.filter((s) => role.skills.includes(s.name))
      : [];

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noSkills: false,
      skillsOverride: makeRoleSkillsOverride({ domainSkills }),
    } as any);

    // Per-node ReportState — isolated so one child's payload doesn't pollute another's.
    const childReportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const childReportTool = makeReportTool({ state: childReportState, schema: role?.outputSchema ?? DEFAULT_REPORT_SCHEMA, failedStep: roleName });
    // T1-4: resolve the role's model via ctx.modelRegistry (was hardcoded undefined).
    const modelRef = role?.model;
    const resolvedModel = modelRef && modelRegistry ? resolveModelRef(modelRef, modelRegistry) : undefined;
    // T1-4: caller sessionFile so DAG nodes join the tree-abort tree (was undefined).
    const callerSessionFile = getCallerSessionFile?.();

    const id = service.spawn({
      role: roleName,
      task,
      parentSessionId: callerSessionFile, // T1-4: was undefined — DAG nodes now join the abort tree
      tools: childTools,
      maxTurns: role?.maxTurns ?? 25,
      model: resolvedModel, // T1-4: was undefined — role.model now resolved + forwarded
      thinkingLevel: role?.thinkingLevel,
      resourceLoader,
      customTools: [childReportTool],
      signal, // T1-4: forward the tool AbortSignal so a mid-DAG abort reaches in-flight children
      onSessionCreated: (sessionFile, rn) => {
        deps.reportState.activeRole.set(sessionFile, rn);
        console.error(`[pi-roles:dag] recorded activeRole[${sessionFile}]=${rn}`);
      },
    });

    return {
      agentId: id,
      wait: async () => {
        const rec = await service.waitForResult(id);
        const payload = rec.reportPayload
          ?? (rec.sessionFile ? deps.reportState.payloads.get(rec.sessionFile) : undefined);
        // T1-3: payload may be a custom-schema shape (not findings/artifacts).
        // DAG NodeResult.result is NodePayload ({findings, artifacts}) — adapt:
        // if the payload has findings/artifacts arrays use them, else wrap as a
        // single finding so custom-schema role output still flows downstream.
        const np: NodePayload = payload && Array.isArray((payload as any).findings) && Array.isArray((payload as any).artifacts)
          ? { findings: (payload as any).findings, artifacts: (payload as any).artifacts, ...payload }
          : { findings: payload ? [JSON.stringify(payload)] : (rec.result ? [rec.result] : []), artifacts: [] };
        return {
          status: rec.status as "completed" | "aborted" | "error" | "failed",
          result: np,
          error: rec.error ?? rec.reason,
          reportPayload: payload,
        };
      },
    };
  };
}

export function makeDagExecuteTool(deps: DagExecuteDeps) {
  return defineTool({
    name: "dag_execute",
    label: "Execute DAG",
    description: "Execute a DAG of subagent roles — topological waves, parallel spawn per wave, Promise.allSettled barrier, partial-failure isolation. Returns {status, waves, finalContext}.",
    parameters: Params,
    async execute(_toolCallId: string, params: { spec: DAGSpec; maxConcurrent?: number }, signal, onUpdate, _ctx) {
      const spec = params.spec as DAGSpec;
      if (!spec.nodes || Object.keys(spec.nodes).length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "failed", reason: "empty DAG" }) }], details: { status: "failed", reason: "empty DAG" } };
      }
      // T1-4: thread ctx.modelRegistry + the tool AbortSignal + caller sessionFile
      // into buildSpawnFn so each child gets signal/model/parentSessionId forwarded.
      const ctx = _ctx as any;
      const spawnFn = buildSpawnFn(deps, {
        modelRegistry: ctx?.modelRegistry,
        signal,
        getCallerSessionFile: () => ctx?.sessionManager?.getSessionFile?.(),
      });
      // Forward progress events through pi's streaming tool-update channel (Gap P3).
      const onProgress = onUpdate
        ? (p: { currentWave: number; totalWaves: number; nodes?: Record<string, { status: string }> }) => {
            const nodeCount = p.nodes ? Object.keys(p.nodes).length : 0;
            onUpdate({ content: [{ type: "text" as const, text: `DAG wave ${p.currentWave + 1}/${p.totalWaves} (${nodeCount} nodes) running...` }], details: undefined });
          }
        : undefined;
      const result = await executeDAGCore(spec, spawnFn, { maxConcurrent: params.maxConcurrent, onProgress, signal });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
