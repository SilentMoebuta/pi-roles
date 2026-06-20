// report_role_result live probe v2 — uses the REAL SubagentsService.spawn path
// (spawn-role-tool.ts childTools force-includes report_role_result → createSession
// → createAgentSession with tools allowlist including report_role_result). Proves
// the actual production spawn path yields a child session whose active tools
// include report_role_result — no handler/bindExtensions needed (allowlist is
// the real mechanism). Independent node process → fresh disk code from git repo.
//
// Run: npx tsx scripts/probe-report-role-result-live-v2.ts
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { SubagentsService } from "../src/subagent/service";
import type { SpawnDeps } from "../src/subagent/spawn";
import { makeSpawnRoleTool } from "../src/subagent/spawn-role-tool";
import { parseRoleFrontmatter, type RoleDef } from "../src/roles";
import * as fs from "node:fs";

const fakeModel = {
  id: "probe-model", name: "Probe", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://probe.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
} as any;

async function main() {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/pi-rr-v2-"));
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const rolesDir = path.resolve("roles");
  const roleRegistry = new Map<string, RoleDef>();
  for (const f of fs.readdirSync(rolesDir).filter(x => x.endsWith(".md"))) {
    const r = parseRoleFrontmatter(path.join(rolesDir, f));
    roleRegistry.set(r.name, r);
  }
  const coder = roleRegistry.get("coder")!;
  console.log("coder role tools:", coder.tools);

  // Replicate index.ts createSession dep, but capture the session to inspect tools.
  let capturedSession: any = null;
  const spawnDeps: SpawnDeps = {
    makeSessionManager: (cwd) => SessionManager.create(cwd),
    createSession: async (opts) => {
      // Inline minimal createAgentSession import to inspect the resulting session.
      console.log("  createSession received tools:", opts.tools);
      const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
      const { session } = await createAgentSession({
        cwd: opts.cwd, agentDir: opts.agentDir, sessionManager: opts.sessionManager,
        tools: opts.tools, model: fakeModel, thinkingLevel: opts.thinkingLevel as any,
        resourceLoader: opts.resourceLoader as any,
        customTools: opts.customTools as any,
      });
      capturedSession = session;
      return { session: session as any };
    },
  };
  const service = new SubagentsService(spawnDeps, { cwd: tmpDir, agentDir });

  // Drive the REAL spawn_role tool path (childTools = role.tools + report_role_result).
  const tool = makeSpawnRoleTool({
    roleRegistry,
    service,
    reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as any,
  } as any);

  // Execute spawn_role for coder (background — returns immediately, child session created).
  const result = await (tool as any).execute("tc1", { role: "coder", task: "noop probe", mode: "background" }, undefined, undefined, { cwd: tmpDir, agentDir });
  console.log("spawn_role result:", JSON.stringify(result.details));

  // Wait for the child session to actually be created (spawn is fire-and-forget).
  for (let i = 0; i < 50 && !capturedSession; i++) await new Promise(r => setTimeout(r, 50));

  // Inspect the captured child session's active tools.
  if (!capturedSession) { console.error("FAIL: no session captured"); process.exit(1); }
  const active = capturedSession.getActiveToolNames();
  console.log("child session active tools (REAL spawn path):", active);
  console.log("  includes report_role_result?", active.includes("report_role_result"));
  assert.ok(active.includes("report_role_result"),
    "REAL spawn path: report_role_result MUST be in child active tools (childTools force-includes it)");
  console.log("✓ report_role_result IS active in a child spawned via the real SubagentsService + spawn_role tool path");
  console.log("  (allowlist mechanism — no bindExtensions/session_start handler needed)");
}

main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
