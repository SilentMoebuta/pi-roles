// report_role_result live-equivalent probe (independent node process).
// Verifies the c4dffc9 fix against the REAL pi runtime + REAL pi-roles extension
// (fresh-required from disk — NOT the parent pi's cached module), WITHOUT needing
// the parent pi process to restart.
//
// What it proves: when a child session is created with parentSession set (role
// session) and bindExtensions is called (the c4dffc9 fix), the pi-roles
// session_start handler fires and additively adds report_role_result to the
// child's active tools — i.e. the fix actually works end-to-end at the runtime
// level, not just in unit mocks.
//
// Run: npx tsx scripts/probe-report-role-result-live.ts
import { createAgentSession, SessionManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";

const fakeModel = {
  id: "probe-model", name: "Probe", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://probe.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
} as any;

async function main() {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/pi-rr-probe-"));
  const agentDir = path.join(os.homedir(), ".pi", "agent"); // REAL agent dir → loads pi-roles

  // resourceLoader with the real agentDir so pi-roles (and its session_start
  // handler) is discovered/loaded — same as a real child session.
  const resourceLoader = new DefaultResourceLoader({
    cwd: tmpDir,
    agentDir,
    noSkills: false,
  } as any);
  await (resourceLoader as any).reload?.();

  const sm = SessionManager.create(tmpDir);
  // Mark as a CHILD (role) session — parentSession set → isSubagentSession true.
  sm.newSession({ parentSession: "test-parent-session-id" });
  const header = (sm as any).getHeader();
  assert.equal(header?.parentSession, "test-parent-session-id");
  console.log("✓ child session created with parentSession header (role session)");

  const { session } = await createAgentSession({
    cwd: tmpDir,
    agentDir,
    sessionManager: sm,
    tools: ["read", "bash", "grep", "report_role_result"], // coder whitelist + force-included report_role_result (mirrors spawn-role-tool.ts:151)
    model: fakeModel,
    resourceLoader,
  });
  console.log("✓ createAgentSession loaded pi-roles extension via real agentDir");

  // DIAGNOSTIC: did pi-roles actually load + register its tools/handlers?
  const exts = (resourceLoader as any).getExtensions?.() ?? { extensions: [] };
  const extNames = (exts.extensions ?? []).map((e: any) => e.path || e.name || "?");
  console.log("  loaded extensions:", extNames.length, "paths:", extNames.map((s: string) => s.split("/").pop()).slice(0, 20));
  const piRolesLoaded = extNames.some((p: string) => String(p).includes("pi-roles"));
  console.log("  pi-roles extension loaded?", piRolesLoaded);
  const allTools = (exts.extensions ?? []).flatMap((e: any) => [...(e.tools?.keys?.() ?? [])]);
  console.log("  all registered tools across extensions:", allTools);
  console.log("  report_role_result registered?", allTools.includes("report_role_result"));

  // BEFORE bindExtensions: report_role_result should NOT be active (allowlist
  // filtered it out at construction — the bug).
  const before = session.getActiveToolNames();
  console.log("  active tools BEFORE bindExtensions:", before);
  assert.ok(!before.includes("report_role_result"),
    "before bindExtensions, report_role_result must NOT be active (the bug)");

  // THE FIX (c4dffc9): service.ts calls bindExtensions before prompt. This fires
  // session_start → pi-roles handler additively adds report_role_result.
  await session.bindExtensions({ mode: "print" });
  console.log("✓ session.bindExtensions({mode:'print'}) called (the c4dffc9 fix path)");

  // DIAGNOSTIC: inspect the session's extension runner — does it have a session_start
  // handler registered by pi-roles? And does the session's sessionManager header still
  // show parentSession (the handler's isSubagentSession guard reads this)?
  const runner = (session as any)._extensionRunner;
  if (runner) {
    const exts2 = (runner as any).extensions ?? [];
    console.log("  runner.extensions count:", exts2.length);
    let foundHandler = false;
    for (const ext of exts2) {
      const path = ext.path ?? "";
      if (String(path).includes("pi-roles")) {
        const handlers = ext.handlers ?? new Map();
        const ss = handlers.get?.("session_start") ?? [];
        console.log("  pi-roles session_start handlers:", ss.length);
        foundHandler = ss.length > 0;
      }
    }
    console.log("  pi-roles session_start handler registered?", foundHandler);
  } else {
    console.log("  NO _extensionRunner on session (cannot inspect handlers)");
  }
  const hdr2 = (session as any).sessionManager?.getHeader?.() ?? (sm as any).getHeader?.();
  console.log("  session header after bindExtensions:", JSON.stringify(hdr2));

  // AFTER bindExtensions: report_role_result MUST be active (handler added it).
  const after = session.getActiveToolNames();
  console.log("  active tools AFTER bindExtensions:", after);

  // DIAGNOSTIC: does setActiveToolsByName even work on this session? (sanity)
  session.setActiveToolsByName(["read", "bash", "grep", "report_role_result"]);
  const afterManual = session.getActiveToolNames();
  console.log("  active tools after MANUAL setActiveToolsByName(+rr):", afterManual);
  console.log("  manual setActiveToolsByName worked?", afterManual.includes("report_role_result"));
  assert.ok(after.includes("report_role_result"),
    "after bindExtensions, report_role_result MUST be active — the handler fired and added it");
  console.log("✓ report_role_result is now ACTIVE after bindExtensions (fix verified at runtime)");

  // Whitelist preserved: read/bash/grep still there (additive, not replacement).
  for (const want of ["read", "bash", "grep"]) {
    assert.ok(after.includes(want), `whitelist preserved — ${want} still active (additive, not replaced)`);
  }
  console.log("✓ original whitelist preserved (additive — reviewer stays read-only etc.)");

  console.log("\nPROBE PASSED — report_role_result fix verified against real pi runtime + real pi-roles extension.");
  console.log("(Independent node process → fresh-required disk code c4dffc9, NOT parent pi's cached module.)");
}

main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
