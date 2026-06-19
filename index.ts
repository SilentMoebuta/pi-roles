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
      });
      return { session: session as any };
    },
  };
  const service = new SubagentsService(spawnDeps, { cwd: process.cwd(), agentDir: path.join(process.env.HOME ?? "", ".pi", "agent") });

  pi.registerTool(makeSpawnRoleTool({
    roleRegistry,
    service,
    reportState,
  }) as any);

  // before_agent_start: persona injection — DESCOPED (no criterion mandates it).
  // Role-session detection + persona injection is future multi-roles work.
  pi.on("before_agent_start", () => undefined);

  // resources_discover: per-role skill isolation — DESCOPED (no criterion mandates it).
  // Returning undefined leaves pi's default skill discovery unchanged.
  pi.on("resources_discover", () => undefined);
}
