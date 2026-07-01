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
import { createDenyRulesExtension } from "./deny-rules";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { RoleDef } from "../roles";
import type { ReportState } from "../report-tool";
import { makeReportTool } from "../report-tool";
import { DEFAULT_REPORT_SCHEMA, type ReportSchema } from "../contract";
import { makeRoleSkillsOverride } from "./skills-override";
import { discoverRoleSkillDirs } from "./role-skills-discovery";

// Resolves a role frontmatter model reference (bare id 'deepseek-v4-flash' or
// 'provider/modelId') to a Model object using the tool execution context's
// modelRegistry (ExtensionContext.modelRegistry — the main session's registry,
// with in-memory credentials, so children reuse auth, not re-read disk).
// findExactModelReferenceMatch is not a public pi export, so we scan getAll().
export function resolveModelRef(modelRef: string, registry: { getAll(): any[]; find(provider: string, id: string): any | undefined }): any | undefined {
  const slash = modelRef.indexOf("/");
  if (slash > 0) {
    return registry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
  }
  return registry.getAll().find((m: any) => m.id === modelRef);
}

export interface SpawnToolService {
  spawn(params: {
    role?: string;
    task: string;
    parentSessionId?: string;
    tools?: string[];
    maxTurns?: number;
    maxDepth?: number;
    model?: unknown;
    thinkingLevel?: unknown;
    resourceLoader?: unknown;
    customTools?: unknown[];
    onSessionCreated?: (sessionFile: string, role: string) => void;
    onComplete?: (rec: { id: string; status: string; result?: string; error?: string; reportPayload?: Record<string, unknown>; turnCount: number; sessionFile?: string }) => void;
    signal?: AbortSignal;
  }): string;
  waitForResult(id: string): Promise<SpawnToolRecord>;
  getRecord(id: string): SpawnToolRecord | undefined;
  getAbortController(id: string): { abort: () => void } | undefined;
  abort(id: string): boolean;
}

export interface SpawnToolRecord {
  id: string;
  status: string; // "completed" | "aborted" | "error" | ...
  result?: string;
  error?: string;
  reason?: string;
  turnCount?: number;
  sessionFile?: string;
  reportPayload?: Record<string, unknown>;
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
  /** P0-1: inject a message into the parent session (pi.sendUserMessage).
   *  Used by background mode to notify the parent when a child completes. */
  notifyParent?: (text: string) => void;
}

/** Inline role definition for ad-hoc expert dispatch (cce V4-style dynamic
 *  experts). No disk file, no skills dir. Safe defaults enforced by buildInlineRole:
 *  canSpawn=false (anti-cascade), skills=[] (no disk loading). */
export interface InlineRoleDef {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  maxTurns?: number;
  canSpawn?: boolean;
  model?: string;
  thinkingLevel?: string;
  /** P1 (full): custom report schema for this ad-hoc role's report_role_result.
   *  Lets an inline router declare a `route` field (or any custom output) without
   *  a disk role file. Falls back to DEFAULT_REPORT_SCHEMA ({findings, artifacts}). */
  outputSchema?: ReportSchema;
}

/** Construct a RoleDef from an inline definition with safe defaults.
 *  Ad-hoc roles never load skills from disk (no dir) and default canSpawn=false
 *  (anti-cascade) — avoids replicating cce V4's spawn-loop debts. */
export function buildInlineRole(def: InlineRoleDef): RoleDef {
  return {
    name: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.tools,
    skills: [], // forced: ad-hoc roles don't load skills from disk
    maxTurns: def.maxTurns ?? 30,
    canSpawn: def.canSpawn ?? false, // default false (anti-cascade)
    teammates: [],
    model: def.model,
    thinkingLevel: def.thinkingLevel,
    outputSchema: def.outputSchema,
  };
}

/** Resolve role from either inline roleDef or registry name. Mutually exclusive.
 *  Returns {role} on success, {error} on failure (unknown role / both provided / neither). */
export function resolveRole(
  params: { role?: string; roleDef?: InlineRoleDef },
  registry: Map<string, RoleDef>,
): { role?: RoleDef; error?: string } {
  if (params.role && params.roleDef) {
    return { error: "Provide role OR roleDef, not both (mutually exclusive)." };
  }
  if (params.roleDef) return { role: buildInlineRole(params.roleDef) };
  if (params.role) {
    const r = registry.get(params.role);
    if (!r) return { error: `unknown role: ${params.role}` };
    return { role: r };
  }
  return { error: "Either (role + task) or (roleDef + task) for spawn, or agentId for join is required." };
}

const Params = Type.Object({
  role: Type.Optional(Type.String({ description: "Name of the role to spawn (from role catalog). Mutually exclusive with roleDef." })),
  roleDef: Type.Optional(Type.Object({
    name: Type.String(),
    description: Type.String(),
    prompt: Type.String(),
    tools: Type.Array(Type.String()),
    maxTurns: Type.Optional(Type.Number()),
    canSpawn: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(Type.String()),
  }, { description: "Inline role definition for ad-hoc expert dispatch (cce V4-style dynamic experts). No disk file. Mutually exclusive with role. Safe defaults: canSpawn=false, skills=[]." })),
  task: Type.Optional(Type.String({ description: "The task for the role to perform. Required for spawn. Omit for join (agentId only)." })),
  mode: Type.Optional(Type.Union([
    Type.Literal("foreground"),
    Type.Literal("background"),
  ], { description: "foreground (default) blocks until the role finishes; background returns immediately (Phase 5, not yet supported)." })),
  model: Type.Optional(Type.String({ description: "Override the role's default model. Use provider/modelId (e.g. 'testprov/test-model') or bare id (e.g. 'deepseek-v4-flash'). If omitted, the role's preset model is used." })),
  maxTurns: Type.Optional(Type.Number({ description: "Override the role's maxTurns (turn budget). Useful for deep research (9999) vs quick lookup (30). If omitted, the role's preset maxTurns is used." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Override the role's thinking level (e.g. 'low', 'medium', 'high', 'xhigh'). If omitted, the role's preset thinkingLevel is used." })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum nesting depth for recursive spawns. Default 5. Decrements per nesting level. Sub-agents at depth <=0 cannot spawn further." })),
  agentId: Type.Optional(Type.String({ description: "Wait for a background agent by its ID. If provided, blocks until the agent completes and returns its result (join mode)." })),
  retryCount: Type.Optional(Type.Number({ description: "P2-4: number of retries on abort/error (max 3, exponential backoff 500ms-2s). Default 0." })),
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
    async execute(_toolCallId: string, params: { role?: string; roleDef?: InlineRoleDef; task: string; mode?: "foreground" | "background"; model?: string; maxTurns?: number; thinkingLevel?: string; maxDepth?: number; agentId?: string; retryCount?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
      // Join mode: wait for a background agent by its ID.
      if (params.agentId) {
        const rec = await deps.service.waitForResult(params.agentId);
        const payload = rec.reportPayload ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] });
        if (rec.status === "completed") return okResult({ status: "completed", result: payload, agentId: params.agentId });
        if (rec.status === "aborted") return okResult({ status: "aborted", error: rec.reason ?? "aborted", agentId: params.agentId });
        return okResult({ status: "error", error: rec.error ?? rec.reason ?? "unknown error", agentId: params.agentId });
      }

      // Spawn mode: require task + (role OR roleDef), mutually exclusive.
      if (!params.task) {
        return okResult({ status: "error", error: "task is required for spawn (or agentId for join)." });
      }
      if (params.role && params.roleDef) {
        return okResult({ status: "error", error: "Provide role OR roleDef, not both (mutually exclusive)." });
      }
      if (!params.role && !params.roleDef) {
        return okResult({ status: "error", error: "Either role or roleDef is required for spawn (or agentId for join)." });
      }

      const mode = params.mode ?? "foreground";

      // Depth limit: maxDepth decrements per nesting level.
      const effectiveMaxDepth = params.maxDepth ?? 5;
      if (effectiveMaxDepth <= 0) {
        return okResult({ status: "error", error: "Max nesting depth reached. Cannot spawn subagent." });
      }
      const childDepth = effectiveMaxDepth - 1;

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

      const resolved = resolveRole(params, deps.roleRegistry);
      if (resolved.error || !resolved.role) {
        return okResult({ status: "error", error: resolved.error ?? "role resolution failed" });
      }
      const role = resolved.role;

      // The role's `tools` whitelist drives the child's createSession allowlist.
      // BUT report_role_result is the output-contract tool — every role MUST be
      // able to call it to report its structured result, so force-include it.
      // (Anti-cascade is about spawn_role/subagent, not the read-only report tool.)
      // anti-cascade: when depth is exhausted, strip spawn tools from child set
      // BEFORE the session starts — saves a turn vs call-time error (P1-2).
      // Mirrors Claude Code's hard depth-5 where sub-agent loses Agent tool.
      let childTools = Array.from(new Set([...role.tools, "report_role_result"]));
      // P2-2: strip explicitly disallowed tools.
      if (role.disallowedTools) {
        childTools = childTools.filter(t => !role.disallowedTools!.includes(t));
      }
      if (childDepth <= 0) {
        childTools = childTools.filter(t => t !== "spawn_role" && t !== "dag_execute" && t !== "dag_resume");
      }

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
      // PM-CORE-1: dynamic scan replaces the hardcoded 5-role array — any
      // roles/*-skills/ dir is auto-discovered (pm-skills, future roles).
      const _thisDir = path.dirname(fileURLToPath(import.meta.url));
      const rolesRoot = path.resolve(_thisDir, "..", "..", "roles");
      const roleSkillsDirs = discoverRoleSkillDirs(rolesRoot);
      const allSkills: Skill[] = [];
      for (const d of roleSkillsDirs) {
        const dir = path.resolve(_thisDir, "..", "..", "roles", d);
        try {
          const { skills } = loadSkillsFromDir({ dir, source: "pi-roles-roles" });
          allSkills.push(...skills);
        } catch { /* no skills dir — skip */ }
      }
      const domainSkills: Skill[] = allSkills.filter((s) => role.skills.includes(s.name));

      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noSkills: false,
        skillsOverride: makeRoleSkillsOverride({ domainSkills }),
        // P1-1 + P2-1: inject deny-rules extension that intercepts tool_call
        // events at runtime. extensionsOverride appends our extension to the
        // loaded set; ExtensionRunner.emitToolCall iterates all extensions'
        // handlers. A {block:true} return skips tool execution (agent-loop.js:386).
        extensionsOverride: role.toolDenyRules && Object.keys(role.toolDenyRules).length > 0
          ? (result: any) => {
              result.extensions.push(createDenyRulesExtension(role.toolDenyRules!));
              return result;
            }
          : undefined,
      } as any);

      // D-bug fix (2026-07-01 重验 bb93b74 发现的真根因): DefaultResourceLoader
      // 构造时 extensionsResult={extensions:[]}(loaded=false), 必须 reload() 才加载
      // ext(pi-web-access→web_search/fetch_content, pi-codegraph→codegraph_*, 等)。
      // createAgentSession 收到 resourceLoader 不 reload(sdk.ts 只 !resourceLoader 分支
      // 才 reload)。不 reload → ext 从未加载 → web_search 不进 _toolRegistry →
      // setActiveToolsByName 的 `if(tool)` 过滤 → role 报 ext 工具 'unknown tool'。
      // bb93b74 的 setActiveToolsByName 在 ext 未加载时治不了病 (registry 无 ext)。
      // 修法: 构造后 reload(), ext 加载进 _toolRegistry, bindExtensions 内部 + bb93b74
      // 的 setActiveToolsByName 才能保留 ext 工具。
      await resourceLoader.reload();

      // Phase 5 report_role_result fix: the skillsOverride resourceLoader does NOT
      // register pi-roles' report_role_result tool (probed: isAllowedTool filters it
      // out of active tools even though childTools includes it). Register it directly
      // as a customTool on the child session — createAgentSession's customTools bypass
      // the resourceLoader's extension set. The child gets its OWN ReportState (empty);
      // the structured payload is recovered by service.ts scanning the child session's
      // messages for the report_role_result toolCall (extractReportPayload), NOT via
      // this state — so an isolated per-child state avoids polluting the parent's.
      const childReportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
      const childReportTool = makeReportTool({ state: childReportState, schema: role.outputSchema ?? DEFAULT_REPORT_SCHEMA, failedStep: role.name });

      const onSessionCreated = (sessionFile: string, roleName: string) => {
        deps.reportState.activeRole.set(sessionFile, roleName);
        console.error(`[pi-roles:spawn] recorded activeRole[${sessionFile}]=${roleName}`);
      };

      const id = deps.service.spawn({
        role: role.name,
        task: params.task,
        parentSessionId: callerSessionFile,
        tools: childTools,
        maxTurns: params.maxTurns ?? role.maxTurns,
        maxDepth: childDepth,
        model: resolvedModel,
        thinkingLevel: params.thinkingLevel ?? role.thinkingLevel,
        resourceLoader,
        customTools: [childReportTool],
        onSessionCreated,
        signal,
        // P0-1: for background mode, notify parent when child completes.
        onComplete: mode === "background" && deps.notifyParent
          ? (rec: { id: string; status: string; result?: string; reportPayload?: Record<string, unknown>; sessionFile?: string }) => {
              const payload = rec.reportPayload
                ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] });
              deps.notifyParent!(
                `[Background task ${rec.id} (${params.role}) completed: ${rec.status}]\nFindings: ${JSON.stringify(payload.findings)}\nArtifacts: ${JSON.stringify(payload.artifacts)}`
              );
              // Also store the payload in reportState for join to pick up.
              if (rec.sessionFile) {
                deps.reportState.payloads.set(rec.sessionFile, payload);
              }
            }
          : undefined,
      });

      // ponytail: background mode returns agentId only — no AgentHandle is
      // constructed, so nothing clone-unsafe enters the tool result or messages.
      if (mode === "background") {
        return okResult({ status: "running", agentId: id });
      }

      // Foreground mode: await completion directly (no handle needed).
      // T1-1: when the TOOL's signal aborts (caller cancels), cascade-abort the
      // spawned subtree. service.spawn({signal}) already aborts the DIRECT child's
      // AbortController, but does NOT walk the tree — service.abort(id) does, so
      // grandchildren get cancelled too (the missing prod caller the reviewer
      // flagged: abort had zero prod callers → tree-abort was dormant). Idempotent
      // (abort guards on already-aborted). {once:true} → no leak.
      if (signal) signal.addEventListener("abort", () => deps.service.abort(id), { once: true });

      let retries = Math.min(params.retryCount ?? 0, 3);
      let rec = await deps.service.waitForResult(id);
      // P2-4: retry on abort/error with exponential backoff.
      while (retries > 0 && (rec.status === "aborted" || rec.status === "error")) {
        const delay = (3 - retries + 1) * 500; // 500ms, 1s, 2s
        await new Promise(r => setTimeout(r, delay));
        // T3-7: reconstruct childReportState + childReportTool per retry attempt.
        // Reusing the outer-scope instances left attempt 1's `reported`/`payloads`
        // in the shared state → on a degenerate session key ('default' fallback)
        // attempt 2 falsely hit duplicate_report. resourceLoader is stateless
        // (reconstructing re-reads 5 skills dirs = pessimization), so it's reused.
        const retryReportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
        const retryReportTool = makeReportTool({ state: retryReportState, schema: role.outputSchema ?? DEFAULT_REPORT_SCHEMA, failedStep: role.name });
        const newId = deps.service.spawn({
          role: role.name,
          task: params.task,
          parentSessionId: callerSessionFile,
          tools: childTools,
          maxTurns: params.maxTurns ?? role.maxTurns,
          maxDepth: childDepth,
          model: resolvedModel,
          thinkingLevel: params.thinkingLevel ?? role.thinkingLevel,
          resourceLoader,
          customTools: [retryReportTool],
          onSessionCreated,
          signal,
        });
        rec = await deps.service.waitForResult(newId);
        retries--;
      }
      const payload = rec.reportPayload
        ?? (rec.sessionFile ? deps.reportState.payloads.get(rec.sessionFile) : undefined);
      const result = payload ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] });

      if (rec.status === "completed") return okResult({ status: "completed", result, agentId: rec.id ?? id, sessionFile: rec.sessionFile });
      if (rec.status === "aborted") return okResult({ status: "aborted", error: rec.reason ?? "aborted", agentId: rec.id ?? id, sessionFile: rec.sessionFile });
      return okResult({ status: "error", error: rec.error ?? rec.reason ?? "unknown error", agentId: rec.id ?? id, sessionFile: rec.sessionFile });
    },
  });
}
