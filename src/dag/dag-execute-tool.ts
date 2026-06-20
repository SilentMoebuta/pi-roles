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
import { executeDAG, type SpawnFn } from "./executor";
import type { DAGSpec } from "./types";
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
function buildSpawnFn(deps: DagExecuteDeps): SpawnFn {
  const { roleRegistry, service, cwd, agentDir } = deps;
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
    const childReportTool = makeReportTool({ state: childReportState, schema: DEFAULT_REPORT_SCHEMA, failedStep: roleName });

    const id = service.spawn({
      role: roleName,
      task,
      parentSessionId: undefined, // DAG nodes may or may not have a parentSession; leave undefined
      tools: childTools,
      maxTurns: role?.maxTurns ?? 25,
      model: undefined, // let child inherit session default; per-node model override can be added later
      thinkingLevel: role?.thinkingLevel,
      resourceLoader,
      customTools: [childReportTool],
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
        return {
          status: rec.status as "completed" | "aborted" | "error" | "failed",
          result: payload ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] }),
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
    async execute(_toolCallId: string, params: { spec: DAGSpec }, _signal, _onUpdate, _ctx) {
      const spec = params.spec as DAGSpec;
      if (!spec.nodes || Object.keys(spec.nodes).length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "failed", reason: "empty DAG" }) }], details: { status: "failed", reason: "empty DAG" } };
      }
      const spawnFn = buildSpawnFn(deps);
      const result = await executeDAG(spec, spawnFn);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
