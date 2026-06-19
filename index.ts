import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoleFrontmatter, type RoleDef } from "./src/roles";
import { makeReportTool, type ReportState } from "./src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "./src/contract";

// ESM: __dirname is undefined under "type":"module". Derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function (pi: ExtensionAPI): Promise<void> {
  const cfg = { maxDepth: 3, livenessTimeoutMs: 300000 };
  const roleRegistry = new Map<string, RoleDef>();
  // Load roles from ./roles/*.md (best-effort)
  try {
    const dir = path.join(__dirname, "roles");
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
      const r = parseRoleFrontmatter(path.join(dir, f));
      roleRegistry.set(r.name, r);
    }
  } catch { /* no roles dir yet — registry empty, spawn_role will reject unknown role */ }

  // ESM: require() is undefined under "type":"module". The @gotgenes/pi-subagents
  // package ships an ESM .ts main, so a dynamic import() (resolved through pi's
  // tsx loader) is the correct loader. Best-effort: stays undefined if absent.
  let getSubagentsService: (() => unknown) | undefined;
  try {
    const mod = await import("@gotgenes/pi-subagents");
    getSubagentsService = (mod as any).getSubagentsService;
  } catch { /* @gotgenes/pi-subagents not installed; spawn_role reports service unavailable */ }

  // Per-session report state: a Set of session keys that have reported, plus a
  // per-session active-role map for accurate failedStep attribution. Keyed by
  // session file path (resolved in the tool from ctx.sessionManager) so multiple
  // role sessions in one runtime do not collide. activeRole is populated when a
  // role session is spawned (spawn_role wiring is future work); until then
  // failedStep falls back to "default".
  const reportState: ReportState = { reported: new Set<string>(), activeRole: new Map<string, string>() };
  pi.registerTool(makeReportTool({ state: reportState, schema: DEFAULT_REPORT_SCHEMA, failedStep: "default" }) as any);

  // before_agent_start: persona injection — DESCOPED (no criterion mandates it).
  // Role-session detection + persona injection is future multi-roles work.
  pi.on("before_agent_start", () => undefined);

  // resources_discover: per-role skill isolation — DESCOPED (no criterion mandates it).
  // Returning undefined leaves pi's default skill discovery unchanged.
  pi.on("resources_discover", () => undefined);

  // Reference cfg/getSubagentsService so they remain wired for future spawn_role work.
  void cfg; void getSubagentsService;
}
