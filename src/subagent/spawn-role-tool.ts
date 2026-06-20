// spawn_role tool — the main agent's entry to spawn a role-scoped subagent.
//
// Returns a foreground/background-compatible shape {status, result|error, agentId?}.
// Phase 1: foreground only (await waitForResult); background is Phase 5.
//
// Permission reads the CALLER role's canSpawn field — NOT hardcoded isMainAgent.
// Main agent (no parentSession) may spawn; a role subagent may spawn only if its
// role.canSpawn is true (orchestrator roles, team future). Primary anti-cascade is
// the role tool whitelist (executing roles lack spawn_role); canSpawn is secondary.
//
// Role tool whitelist (frontmatter `tools:`, string[]) drives the child's
// createSession allowlist. Phase 1 parses string[]; object {name, allow?} form
// degrades to name with allow ignored (forward-compat for per-key glob).

import { defineTool, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { RoleDef } from "../roles";
import type { ReportState } from "../report-tool";
import { makeRoleSkillsOverride } from "./skills-override";

// Resolves a role frontmatter model reference (bare id 'deepseek-v4-flash' or
// 'provider/modelId') to a Model object using the tool execution context's
// modelRegistry (ExtensionContext.modelRegistry — the main session's registry,
// with in-memory credentials, so children reuse auth, not re-read disk).
// findExactModelReferenceMatch is not a public pi export, so we scan getAll().
function resolveModelRef(modelRef: string, registry: { getAll(): any[]; find(provider: string, id: string): any | undefined }): any | undefined {
  const slash = modelRef.indexOf("/");
  if (slash > 0) {
    return registry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
  }
  return registry.getAll().find((m: any) => m.id === modelRef);
}

export interface SpawnToolService {
  spawn(params: {
    role: string;
    task: string;
    parentSessionId?: string;
    tools?: string[];
    maxTurns?: number;
    model?: unknown;
    thinkingLevel?: unknown;
    resourceLoader?: unknown;
    onSessionCreated?: (sessionFile: string, role: string) => void;
    signal?: AbortSignal;
  }): string;
  waitForResult(id: string): Promise<SpawnToolRecord>;
}

export interface SpawnToolRecord {
  id: string;
  status: string; // "completed" | "aborted" | "error" | ...
  result?: string;
  error?: string;
  reason?: string;
  turnCount?: number;
  sessionFile?: string;
  reportPayload?: { findings: string[]; artifacts: string[] };
}

export interface SpawnToolDeps {
  roleRegistry: Map<string, RoleDef>;
  service: SpawnToolService;
  reportState: ReportState;
  /** Caller's parentSession header — present when the caller is itself a subagent. */
  getCallerParentSession?: () => string | undefined;
  /** Caller's own session file — becomes the child's parentSession id. */
  getCallerSessionFile?: () => string | undefined;
  now?: () => number;
}

const Params = Type.Object({
  role: Type.String({ description: "Name of the role to spawn (from role catalog)." }),
  task: Type.String({ description: "The task for the role to perform." }),
  mode: Type.Optional(Type.Union([
    Type.Literal("foreground"),
    Type.Literal("background"),
  ], { description: "foreground (default) blocks until the role finishes; background returns immediately (Phase 5, not yet supported)." })),
  model: Type.Optional(Type.String({ description: "Override the role's default model. Use provider/modelId (e.g. 'ksyun/glm-5.2') or bare id (e.g. 'deepseek-v4-flash'). If omitted, the role's preset model is used." })),
});

function okResult(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function makeSpawnRoleTool(deps: SpawnToolDeps) {
  return defineTool({
    name: "spawn_role",
    label: "Spawn Role",
    description: "Spawn a role-scoped subagent with persona + tool whitelist + step limit. Foreground: blocks until the role reports its result via report_role_result. Returns {status, result|error, agentId}.",
    parameters: Params,
    async execute(_toolCallId: string, params: { role: string; task: string; mode?: "foreground" | "background"; model?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
      const mode = params.mode ?? "foreground";
      if (mode === "background") {
        return okResult({ status: "error", error: "background mode not supported in Phase 1 (use foreground)" });
      }

      // Permission: caller role's canSpawn. Main agent (no parentSession) always allowed.
      const callerParent = (deps.getCallerParentSession ?? (() => (ctx as any)?.sessionManager?.getHeader?.()?.parentSession))();
      if (callerParent) {
        const callerFile = (deps.getCallerSessionFile ?? (() => (ctx as any)?.sessionManager?.getSessionFile?.()))();
        const callerRoleName = deps.reportState.activeRole.get(callerFile ?? "");
        if (callerRoleName) {
          const callerRole = deps.roleRegistry.get(callerRoleName);
          if (callerRole && !callerRole.canSpawn) {
            return okResult({ status: "error", error: `role '${callerRoleName}' cannot spawn subagents (canSpawn=false)` });
          }
        }
        // callerRoleName unknown → orphan subagent; allow (shouldn't normally happen)
      }

      const role = deps.roleRegistry.get(params.role);
      if (!role) {
        return okResult({ status: "error", error: `unknown role: ${params.role}` });
      }

      // The role's `tools` whitelist drives the child's createSession allowlist.
      // BUT report_role_result is the output-contract tool — every role MUST be
      // able to call it to report its structured result, so force-include it.
      // (Anti-cascade is about spawn_role/subagent, not the read-only report tool.)
      const childTools = Array.from(new Set([...role.tools, "report_role_result"]));

      const callerSessionFile = (deps.getCallerSessionFile ?? (() => (ctx as any)?.sessionManager?.getSessionFile?.()))();

      // Resolve the role's model reference to a real Model object via the
      // tool ctx's modelRegistry (main session registry, in-memory credentials).
      // params.model overrides the role's default model (per-call override).
      // If neither resolves, leave undefined → child inherits session default model.
      const modelRef = params.model ?? role.model;
      const registry = (ctx as any)?.modelRegistry;
      const resolvedModel = modelRef && registry ? resolveModelRef(modelRef, registry) : undefined;

      // Phase 2: build a child resourceLoader with a role-specific skillsOverride.
      // The child's skill set = baseSkills (pi loads, skillsOverride receives) ∪
      // role.domainSkills. Phase 1 roles (skills:[]) inherit the full common pool
      // unchanged (additive). Main agent's resourceLoader is untouched (zero pollution).
      const cwd = (ctx as any)?.cwd ?? process.cwd();
      const agentDir = (ctx as any)?.agentDir ?? path.join(os.homedir(), ".pi", "agent");

      // Load the role's domain skills from role-specific skill directories.
      // Uses pi's public loadSkillsFromDir (ESM: __dirname is undefined; use import.meta.url).
      const _thisDir = path.dirname(fileURLToPath(import.meta.url));
      const roleSkillsDirs = ["researcher-skills", "planner-skills"];
      const allSkills: Skill[] = [];
      for (const d of roleSkillsDirs) {
        const dir = path.resolve(_thisDir, "..", "..", "roles", d);
        const { skills } = loadSkillsFromDir({ dir, source: "pi-roles-roles" });
        allSkills.push(...skills);
      }
      const domainSkills: Skill[] = allSkills.filter((s) => role.skills.includes(s.name));

      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noSkills: false,
        skillsOverride: makeRoleSkillsOverride({ domainSkills }),
      } as any);

      const id = deps.service.spawn({
        role: role.name,
        task: params.task,
        parentSessionId: callerSessionFile,
        tools: childTools,
        maxTurns: role.maxTurns,
        model: resolvedModel,
        thinkingLevel: role.thinkingLevel,
        resourceLoader,
        onSessionCreated: (sessionFile, roleName) => {
          // Record the child's role BEFORE prompt runs, so the agent_end fallback
          // recognizes the session as a role session (in case the model never calls
          // report_role_result).
          deps.reportState.activeRole.set(sessionFile, roleName);
          console.error(`[pi-roles:spawn] recorded activeRole[${sessionFile}]=${roleName}`);
        },
        signal,
      });

      const rec = await deps.service.waitForResult(id);

      // Contract reliability via MECHANISM, not model compliance: spawn_role ALWAYS
      // returns a structured {findings, artifacts} object. Priority:
      //   1. rec.reportPayload — extracted by service from the child session's
      //      messages (the report_role_result tool call's arguments). Works even
      //      though the child loads its own pi-roles instance (separate reportState).
      //   2. reportState.payloads (same-process legacy path; usually empty here).
      //   3. Fallback: wrap rec.result (runner's last assistant text) as {findings:[text]}.
      const payload = rec.reportPayload
        ?? (rec.sessionFile ? deps.reportState.payloads.get(rec.sessionFile) : undefined);
      const result = payload ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] });

      if (rec.status === "completed") {
        return okResult({ status: "completed", result, agentId: id });
      }
      if (rec.status === "aborted") {
        return okResult({ status: "aborted", error: rec.reason ?? "aborted", agentId: id });
      }
      return okResult({ status: "error", error: rec.error ?? rec.reason ?? "unknown error", agentId: id });
    },
  });
}
