import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseRoleFrontmatter, type RoleDef } from "./src/roles";
import { makeReportTool, type ReportState } from "./src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "./src/contract";

export default function (pi: ExtensionAPI): void {
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

  // Lazy import of gotgenes service (sync getter, but module load may be async).
  let getSubagentsService: (() => unknown) | undefined;
  try {
    // require() is synchronous; the module's getSubagentsService export is a sync fn.
    const mod = require("@gotgenes/pi-subagents");
    getSubagentsService = (mod as any).getSubagentsService;
  } catch { /* @gotgenes/pi-subagents not installed; spawn_role reports service unavailable */ }

  // Register a report tool bound to a fresh per-session state.
  // NOTE: a single shared ReportState is sufficient for the scaffold; per-session
  // isolation will be added when role-session detection lands.
  const reportState: ReportState = { reported: false };
  pi.registerTool(makeReportTool({ state: reportState, schema: DEFAULT_REPORT_SCHEMA, failedStep: "default" }) as any);

  // before_agent_start: persona injection — DESCOPED (no criterion mandates it).
  // Role-session detection + persona injection is future multi-roles work.
  pi.on("before_agent_start", () => undefined);

  // resources_discover: per-role skill isolation — DESCOPED (no criterion mandates it).
  // Returning undefined leaves pi's default skill discovery unchanged.
  pi.on("resources_discover", () => undefined);
}
