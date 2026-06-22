import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoleFrontmatter, type RoleDef } from "./src/roles";
import { makeReportTool, type ReportState } from "./src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "./src/contract";
import { SubagentsService } from "./src/subagent/service";
import type { SpawnDeps } from "./src/subagent/spawn";
import { makeSpawnRoleTool } from "./src/subagent/spawn-role-tool";
import { makeRoleSessionStartHandler } from "./src/subagent/session-start-handler";
import { makeAutoCompactHandler } from "./src/subagent/auto-compact-handler";
import { makeOutputContractEnforcer } from "./src/subagent/output-contract-enforcer";
import { makeOutputContractProactiveHandler } from "./src/subagent/output-contract-proactive";
import { makeDagExecuteTool } from "./src/dag/dag-execute-tool";
import { makeDagResumeTool } from "./src/dag/dag-resume-tool";
import { registerPmCommands } from "./src/pm-commands";
import { registerRoleCommands } from "./src/role-commands";
import { buildRolePersonaPrompt, parseActiveRoleFromBranch } from "./src/active-role";
// (agent-end-fallback module removed C5 — dead code, not wired; the child loads
// its own extension instance so a same-process fallback was never reachable.)

// ESM: __dirname is undefined under "type":"module". Derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function (pi: ExtensionAPI): Promise<void> {
  const roleRegistry = new Map<string, RoleDef>();
  // Load roles from ./roles/*.md (best-effort)
  try {
    const dir = path.join(__dirname, "roles");
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
      const r = parseRoleFrontmatter(path.join(dir, f));
      roleRegistry.set(r.name, r);
    }
  } catch { /* no roles dir yet — registry empty, spawn_role rejects unknown role */ }

  // Per-session report state: a Set of session keys that have reported, plus a
  // per-session active-role map for accurate failedStep attribution and canSpawn
  // checks. Keyed by session file path so a long-lived runtime serving multiple
  // role sessions does not collide. activeRole is populated at spawn_role time.
  const reportState: ReportState = { reported: new Set<string>(), activeRole: new Map<string, string>(), payloads: new Map() };
  pi.registerTool(makeReportTool({ state: reportState, schema: DEFAULT_REPORT_SCHEMA, failedStep: "default" }) as any);

  // Self-written execution layer (replaces @gotgenes/pi-subagents).
  // SpawnDeps wires pi's PUBLIC primitives: SessionManager.create + createAgentSession.
  // No fork, no assumption — same public API gotgenes calls internally.
  // Per-role model resolution happens in spawn-role-tool via ctx.modelRegistry
  // (the main session's registry, in-memory credentials); the resolved Model
  // object flows here as opts.model into createAgentSession.
  const spawnDeps: SpawnDeps = {
    makeSessionManager: (cwd) => SessionManager.create(cwd),
    createSession: async (opts) => {
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        agentDir: opts.agentDir,
        sessionManager: opts.sessionManager,
        tools: opts.tools,
        model: opts.model,
        thinkingLevel: opts.thinkingLevel as any,
        resourceLoader: opts.resourceLoader as any,
        customTools: opts.customTools as any,
      });
      return { session: session as any };
    },
  };
  const service = new SubagentsService(spawnDeps, { cwd: process.cwd(), agentDir: path.join(process.env.HOME ?? "", ".pi", "agent") });

  const dagCwd = process.cwd();
  const dagAgentDir = path.join(process.env.HOME ?? "", ".pi", "agent");

  pi.registerTool(makeSpawnRoleTool({
    roleRegistry,
    service,
    reportState,
    // T3-4: deliverAs:'steer' queues the message after the parent's current
    // turn finishes its tool calls (extensions.md). The bare pi.sendUserMessage(text)
    // THROWS when the parent is streaming → the completion notification was
    // silently swallowed. try/catch logs any residual failure (best-effort).
    notifyParent: (text: string) => {
      try { pi.sendUserMessage(text, { deliverAs: "steer" }); }
      catch (e) { console.error("[pi-roles:notifyParent]", e); }
    },
  }) as any);

  pi.registerTool(makeDagExecuteTool({
    roleRegistry,
    service,
    reportState,
    cwd: dagCwd,
    agentDir: dagAgentDir,
  }) as any);

  pi.registerTool(makeDagResumeTool({
    roleRegistry,
    service,
    reportState,
    cwd: dagCwd,
    agentDir: dagAgentDir,
  }) as any);

  // PM role commands (Step 4): register /pm-* slash commands that drive
  // spawn_role(pm, task-with-skill) per option A'.
  registerPmCommands(pi);

  // /role: in-place main-agent persona switching. The main agent adopts a
  // role's persona (preamble + role.md body) via before_agent_start injection,
  // persisted as a `pi-roles:active-role` session entry (append-only, last-wins).
  // `/role <name>` sets, `/role clear` reverts, `/role` shows current. No
  // subagent spawn, no tool/model/thinkingLevel changes. Mirrors pi-goal's
  // appendEntry/getBranch/before_agent_start pattern (pi-goal index.ts:563,618,880).
  // Children load their own pi-roles instance whose closure activeRole starts
  // null and whose branch has no pi-roles:active-role entries → no double-injection.
  let activeRole: string | null = null;

  // before_agent_start: inject the active role's persona into the MAIN session's
  // systemPrompt every turn. Returning undefined when no role is active means the
  // main agent reverts to its default persona naturally — no snapshot stored
  // (before_agent_start fires every turn; not-injecting = revert).
  // Role persona chains AFTER pi-goal governance + superpowers because this
  // handler runs in the extension chain after those extensions (load order); an
  // active pi-goal does NOT block role switching (the two are orthogonal).
  pi.on("before_agent_start", async (event) => {
    if (!activeRole) return;
    const role = roleRegistry.get(activeRole);
    if (!role) return;
    return { systemPrompt: event.systemPrompt + buildRolePersonaPrompt(role) };
  });

  // session_start + session_tree: reconstruct activeRole from the session branch
  // so it survives reload/compaction/tree-switch. Guard against subagent sessions
  // (defensive — children load their own instance, but the guard is cheap and
  // matches pi-goal's isSubagentSession short-circuit).
  const reconstructActiveRole = (ctx: any): void => {
    if (ctx?.sessionManager?.getHeader?.()?.parentSession) return;
    try {
      activeRole = parseActiveRoleFromBranch(ctx.sessionManager.getBranch() as any[]);
    } catch { /* best-effort */ }
  };
  pi.on("session_start", async (_event, ctx) => { reconstructActiveRole(ctx); });
  pi.on("session_tree", async (_event, ctx) => { reconstructActiveRole(ctx); });

  registerRoleCommands(pi, {
    roleRegistry,
    getActiveRole: () => activeRole,
    setActiveRole: (r) => { activeRole = r; },
    appendEntry: (ct, data) => pi.appendEntry(ct, data),
    sendMessage: (msg, opts) => pi.sendMessage(msg as any, opts as any),
  });

  // session_start (A-fix): for role sessions (parentSession present), additively
  // add report_role_result to active tools. Root cause: createAgentSession applies
  // the tools allowlist before extensions register report_role_result, so the tool
  // is filtered out at construction. By session_start (after extensions load) the
  // tool IS registered; this handler adds it back. ADDITIVE only — preserves the
  // role's whitelist (reviewer stays read-only). No cross-session state: the child
  // loads its own pi-roles instance whose handler runs against the child's pi.
  pi.on("session_start", makeRoleSessionStartHandler({
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
  }) as any);

  // P1-5: proactive compaction for role subagents (the researcher maxTurns:9999
  // cliff). A CHILD-side turn_end handler (the child loads its own pi-roles
  // instance — decisive fact — so this fires FOR the child, not the main agent).
  // Reads ctx.getContextUsage().tokens; at 70% of the context window calls
  // ctx.compact({customInstructions}) with a role-specific prompt BEFORE the
  // overflow cliff. Mirrors pi's own examples/extensions/trigger-compact.ts.
  // Spike resolved: ctx.getContextUsage().tokens is available on turn_end
  // (returns last assistant usage when available, then estimates — per docs).
  pi.on("turn_end", makeAutoCompactHandler({
    getRole: (sf) => reportState.activeRole.get(sf ?? ""),
  }) as any);

  // P0-4: proactive output-contract enforcement (hybrid). A CHILD-side agent_end
  // handler (the child loads its own pi-roles instance — decisive fact — so this
  // fires FOR the child). Scans event.messages for a report_role_result toolCall;
  // if absent & retries<2, sends a reminder via sendUserMessage(deliverAs:'steer')
  // — sendUserMessage always triggers a turn (extensions.md:1359) so the child
  // gets another turn. extractReportPayload stays as the reactive fallback (scans
  // on settle). Bounded by maxRetries=2.
  pi.on("agent_end", makeOutputContractEnforcer({
    sendReminder: (text) => {
      try { pi.sendUserMessage(text, { deliverAs: "steer" }); }
      catch (e) { console.error("[pi-roles:output-contract] reminder failed", e); }
    },
  }) as any);

  // G-OUT-2: proactive output-contract enforcement via before_provider_request
  // (the 2nd path). A CHILD-side handler (the child loads its own pi-roles
  // instance — decisive fact — so this fires FOR the child). Gates on the
  // parentSession header (like the enforcer + auto-compact handler); injects
  // tool_choice:"required" so the model is FORCED to call a tool each turn and
  // cannot text-only-finish without calling report_role_result. Complements the
  // reactive P0-4 agent_end enforcer (which stays as the residual safety net).
  // Verified: before_provider_request supports payload-replace (extensions.md:627).
  pi.on("before_provider_request", makeOutputContractProactiveHandler() as any);

  // NOTE: agent_end fallback removed. The child subagent loads its OWN pi-roles
  // extension instance (createAgentSession re-runs resourceLoader.getExtensions),
  // so its agent_end fires into the child's extension runner, NOT the main
  // process's pi.on("agent_end"). Cross-session reportState.payloads never
  // received the child's report_role_result either. Contract reliability is
  // instead enforced in spawn_role itself: service.ts scans the child session's
  // messages for the report_role_result tool call and extracts its structured
  // {findings, artifacts} arguments directly (no cross-session state needed).

  // resources_discover: per-role skill isolation — DESCOPED (no criterion mandates it).
  // (C5: the no-op pi.on handler was removed — returning undefined is redundant;
  // pi's default skill discovery is unchanged.)

  // T3-2: piggyback service.cleanup() on the MAIN session's agent_end (fires
  // after each top-level prompt) to free terminal records + archived session files
  // sooner than the inline-on-settle LRU cap alone. Only the main session triggers
  // this — child subagent sessions load their own pi-roles instance (decisive
  // fact), so this handler doesn't fire for them; their cleanup is via the LRU.
  // ponytail: cleanup is best-effort; an exception here must not break the turn.
  pi.on("agent_end", () => {
    try { service.cleanup(0); } catch { /* best-effort */ }
  });
}
