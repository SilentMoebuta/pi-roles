// probe-p0-4-contract-live.ts — P0-4 live e2e proof.
//
// Spawns a REAL child session via real createAgentSession (default resourceLoader
// loads the pi-roles extension → the child-side agent_end enforcer registers via
// pi.on) + real ksyun/glm-5.2 (settings default). The child is marked as a
// subagent (parentSession header set) so the enforcer's gating
// (getHeader().parentSession) passes. The task makes the model respond WITHOUT
// calling report_role_result → on agent_end the enforcer scans event.messages,
// finds no report_role_result toolCall, and injects a reminder via
// pi.sendUserMessage(deliverAs:'steer', triggerTurn:true). Observable: the
// reminder text appears in the child's session.messages AND (if triggerTurn
// worked) the child ran >1 turn.
//
// Independent node process → fresh disk code (bypasses parent-pi module cache;
// no pi restart needed). Mirrors the accepted probe-bar (probe-phase5-smoke.ts).
//
// Run: npx tsx scripts/probe-p0-4-contract-live.ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as assert from "node:assert/strict";

const REMINDER_RE = /MUST call report_role_result/i;
const TIMEOUT_MS = 120_000;

async function main() {
  const cwd = "/tmp/pi-p04-cwd-" + Date.now();
  fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  // SessionManager with parentSession header → marks this as a child subagent
  // (the P0-4 enforcer gates on getHeader().parentSession).
  const sm = SessionManager.create(cwd);
  sm.newSession({ parentSession: "probe-parent-session" });
  const sessionFile = sm.getSessionFile();
  console.log("[probe] child sessionFile:", sessionFile);

  console.log("[probe] createAgentSession (default resourceLoader loads pi-roles; default model = ksyun/glm-5.2)...");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: sm,
    // Minimal tools allowlist: report_role_result (registered by pi-roles on
    // load). The default resourceLoader registers it → isAllowedTool passes.
    tools: ["report_role_result"],
    thinkingLevel: "low",
    // No model → pi resolves settings default (ksyun/glm-5.2).
    // No resourceLoader → default load (includes pi-roles → enforcer registers).
  }) as any;

  console.log("[probe] active tools:", session.getActiveToolNames?.());
  // pi core createAgentSession does NOT call bindExtensions — fire it so the
  // pi-roles session_start handler runs (additively ensures report_role_result).
  await session.bindExtensions?.({ mode: "print" });
  console.log("[probe] active tools after bindExtensions:", session.getActiveToolNames?.());

  let turnCount = 0;
  let agentEndCount = 0;
  const events: string[] = [];
  const unsub = session.subscribe((e: any) => {
    events.push(e.type);
    if (e.type === "turn_end") turnCount++;
    if (e.type === "agent_end") agentEndCount++;
    if (e.type === "message_end") {
      const role = e.message?.role;
      const tc = (e.message?.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => c.name);
      const txt = (e.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").slice(0, 100);
      console.log(`  [msg ${role}] tools=${JSON.stringify(tc)} text=${JSON.stringify(txt)}`);
    }
  });

  // Hard timeout + abort (we call prompt() directly, not via runSubagent, so no
  // liveness guard). Ensures the probe can't hang the harness.
  const ac = new AbortController();
  const to = setTimeout(() => { console.error("[probe] TIMEOUT — aborting"); try { session.abort?.(); } catch {} ac.abort(); }, TIMEOUT_MS);

  // Task: make the model respond WITHOUT calling report_role_result on turn 1,
  // so the enforcer's agent_end scan finds no report toolCall → fires the reminder.
  const task = "Reply with exactly the word DONE and nothing else. Do not call any tools.";
  console.log("[probe] prompting child...");
  try {
    await session.prompt(task);
  } catch (e) {
    console.log("[probe] prompt threw:", (e as Error)?.message);
  }
  clearTimeout(to);
  unsub();

  const msgs: any[] = session.messages ?? [];
  // Reminder injected via sendUserMessage(deliverAs:'steer') → appears as a
  // non-assistant message. Scan content (string or array) for the reminder text.
  const reminderMsg = msgs.find((m) => {
    if (!m || m.role === "assistant") return false;
    return REMINDER_RE.test(JSON.stringify(m.content ?? ""));
  });
  const reportCalled = msgs.some((m) => m?.role === "assistant" && (m?.content ?? []).some((c: any) => c?.type === "toolCall" && c?.name === "report_role_result"));

  console.log(`[probe] RESULT: turnCount=${turnCount} agentEndCount=${agentEndCount} reportCalled=${reportCalled} reminderInjected=${!!reminderMsg}`);
  console.log(`[probe] event stream: ${events.join(",")}`);

  // PRIMARY ASSERTION: the enforcer fired live — the reminder text is in the
  // child's session.messages. This proves: (1) the child loaded pi-roles, (2) the
  // agent_end handler registered + dispatched for the real child, (3) the gating
  // (parentSession header) passed, (4) sendUserMessage(deliverAs:'steer')
  // delivered the reminder into the child session.
  assert.ok(reminderMsg, "P0-4 LIVE: enforcer must inject the reminder into the child session");
  console.log("✓ P0-4 LIVE: child-side agent_end enforcer fired for a real child session that omitted report_role_result; reminder injected via sendUserMessage(deliverAs:'steer').");

  if (turnCount > 1) {
    console.log(`✓ triggerTurn:true worked: child ran ${turnCount} turns (reminder triggered an extra turn).`);
  } else {
    console.log(`⚠ triggerTurn did not yield an extra turn (turnCount=${turnCount}) — reminder was injected but may not have triggered a new turn (model ended / triggerTurn semantics differ).`);
  }
  if (reportCalled) console.log("✓ child called report_role_result on a subsequent turn (contract satisfied after reminder).");
}

main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
