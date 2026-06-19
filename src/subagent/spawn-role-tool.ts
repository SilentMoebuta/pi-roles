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

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RoleDef } from "../roles";
import type { ReportState } from "../report-tool";

export interface SpawnToolService {
  spawn(params: {
    role: string;
    task: string;
    parentSessionId?: string;
    tools?: string[];
    maxTurns?: number;
    model?: unknown;
    thinkingLevel?: unknown;
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
    async execute(_toolCallId: string, params: { role: string; task: string; mode?: "foreground" | "background" }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
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

      const id = deps.service.spawn({
        role: role.name,
        task: params.task,
        parentSessionId: callerSessionFile,
        tools: childTools,
        maxTurns: role.maxTurns,
        model: role.model,
        thinkingLevel: role.thinkingLevel,
        signal,
      });

      const rec = await deps.service.waitForResult(id);

      // Record the child's role so its own canSpawn checks (if it ever spawns) resolve.
      if (rec.sessionFile) deps.reportState.activeRole.set(rec.sessionFile, role.name);

      // Decision 4旁路 Map: the structured payload the role reported via
      // report_role_result is stored in reportState.payloads keyed by the child
      // session file. Prefer it over the runner's finalText (assistant text fallback).
      const payload = rec.sessionFile ? deps.reportState.payloads.get(rec.sessionFile) : undefined;
      const result = payload ?? rec.result;

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
