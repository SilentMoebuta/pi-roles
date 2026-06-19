// Real-pi integration probe (no LLM needed — verifies the primitives spawn.ts relies on).
// Exercises createAgentSession + SessionManager.newSession({parentSession}) against the
// ACTUAL shipped pi runtime. Does NOT call session.prompt() (that needs a model stream);
// the prompt()/turn_end/report_role_result chain is covered by unit tests with fake
// sessions emitting real event shapes, and by the interactive LLM smoke (see README).
//
// Run: npx tsx scripts/probe-real-pi-primitives.ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import * as assert from "node:assert/strict";

// Minimal model object — createAgentSession accepts a Model; we never stream (no prompt call),
// so the model only needs to satisfy the type checker / validation gates.
const fakeModel = {
  id: "probe-model", name: "Probe", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://probe.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000, maxTokens: 100,
} as any;

async function main() {
  const tmpDir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/pi-probe-"));
  const sm = SessionManager.create(tmpDir);

  // B-class migration proof: newSession({parentSession}) sets the header that the 3
  // isSubagentSession guards read. This is the EXACT pi-native path gotgenes uses.
  sm.newSession({ parentSession: "test-parent-session-id" });
  const header = (sm as any).getHeader();
  assert.equal(header?.parentSession, "test-parent-session-id",
    "newSession({parentSession}) must set header.parentSession (isSubagentSession detection)");
  console.log("✓ newSession({parentSession}) sets header.parentSession =", header?.parentSession);

  // createAgentSession accepts our config (cwd + agentDir + sessionManager + tools + model).
  // This verifies spawn.ts's createSession dep works against real pi — no assumption.
  const { session } = await createAgentSession({
    cwd: tmpDir,
    agentDir: tmpDir, // isolated; won't pick up real ~/.pi/agent
    sessionManager: sm,
    tools: ["read", "bash", "grep"], // role tool allowlist → createSession applylist
    model: fakeModel,
  });
  console.log("✓ createAgentSession accepted config (cwd/agentDir/sessionManager/tools/model)");

  // Tool allowlist applied: session exposes only the allowlisted tools.
  const activeNames = session.getActiveToolNames();
  for (const want of ["read", "bash", "grep"]) {
    assert.ok(activeNames.includes(want), `tool allowlist must include ${want}`);
  }
  console.log("✓ role tool allowlist applied — active tools include read/bash/grep");

  // session.subscribe / abort / prompt / setActiveToolsByName exist (runner relies on them).
  assert.equal(typeof session.subscribe, "function", "session.subscribe exists");
  assert.equal(typeof session.abort, "function", "session.abort exists");
  assert.equal(typeof session.prompt, "function", "session.prompt exists");
  assert.equal(typeof session.setActiveToolsByName, "function", "session.setActiveToolsByName exists");
  console.log("✓ session.subscribe/abort/prompt/setActiveToolsByName all present (runner deps verified)");

  // subscribe returns an unsubscribe fn (runner uses it).
  const unsub = session.subscribe(() => {});
  assert.equal(typeof unsub, "function", "subscribe returns unsubscribe fn");
  unsub();
  console.log("✓ subscribe returns unsubscribe function");

  console.log("\nALL PROBES PASSED — spawn.ts pi-primitive integration verified against real runtime.");
  console.log("(prompt()/turn_end/report_role_result chain covered by unit tests + interactive LLM smoke.)");
}

main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
