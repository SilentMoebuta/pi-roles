// probe-spike-g1-toolchoice-passthrough.ts — Spike-G1 + G-OUT-2 live proof.
//
// Question: does pi's before_provider_request payload-replace let pi-roles
// inject `tool_choice:"required"` AND have it reach the provider? This gates
// G-OUT-2 (proactive tool_choice:'required' 2nd output-contract path).
//
// METHOD: the G-OUT-2 handler is registered in index.ts (pi.on before_provider_request,
// gated on parentSession). The DEFAULT resourceLoader loads pi-roles from the git
// checkout (the "installed" pi-roles IS this repo's working tree — verified by
// probe-p0-4 which exercises the repo's agent_end enforcer the same way). So a
// child created here with default resourceLoader loads THIS branch's pi-roles,
// including the new before_provider_request handler. (Standalone npx tsx process
// → fresh require, no pi module cache.)
//
// DECISIVE: task "Reply DONE, do not call any tools." If tool_choice:"required"
// reaches the provider → the model is FORCED to call a tool on turn 1 (cannot
// text-only-reply) → the FIRST assistant message contains a toolCall. If tool_choice
// is stripped by pi's provider serialization → the model replies "DONE" text-only
// on turn 1 → no toolCall in the first assistant message. (We check the FIRST
// assistant message so the reactive P0-4 enforcer's later reminder turns don't
// confuse the signal.)
//
// Run: npx tsx scripts/probe-spike-g1-toolchoice-passthrough.ts
import { createAgentSession, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as assert from "node:assert/strict";

const TIMEOUT_MS = 120_000;

const markerTool = defineTool({
  name: "marker",
  label: "Marker",
  description: "A no-op marker tool. (Available only because tool_choice may force a call.)",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text" as const, text: "marker called" }], details: { marked: true } };
  },
});

async function main() {
  const cwd = "/tmp/pi-spikeg1-cwd-" + Date.now();
  fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  const sm = SessionManager.create(cwd);
  sm.newSession({ parentSession: "probe-spikeg1-parent" }); // marks child → before_provider_request handler gates ON
  console.log("[spike] child sessionFile:", sm.getSessionFile());

  // DEFAULT resourceLoader → loads pi-roles from the git checkout (this branch),
  // including the new before_provider_request handler. No custom loader (a custom
  // one loaded 0 extensions in standalone context — missing settingsManager).
  console.log("[spike] createAgentSession (default resourceLoader loads this branch's pi-roles; default model = ksyun/glm-5.2)...");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: sm,
    tools: ["marker", "report_role_result"],
    customTools: [markerTool as any],
    thinkingLevel: "low",
    // No resourceLoader → default load (pi-roles → before_provider_request handler registers).
  }) as any;

  await session.bindExtensions?.({ mode: "print" });
  console.log("[spike] active tools:", session.getActiveToolNames?.());

  const ac = new AbortController();
  const to = setTimeout(() => { console.error("[spike] TIMEOUT — aborting"); try { session.abort?.(); } catch {} ac.abort(); }, TIMEOUT_MS);

  // Task explicitly forbids tool use. Under tool_choice:"required" the provider
  // FORCES a tool call on turn 1 regardless → a toolCall in the FIRST assistant msg.
  const task = "Reply with exactly the word DONE and nothing else. Do not call any tools.";
  console.log("[spike] prompting child (task forbids tools; tool_choice:required should FORCE a tool call on turn 1)...");
  try {
    await session.prompt(task, { signal: ac.signal } as any);
  } catch (e) {
    console.log("[spike] prompt threw:", (e as Error)?.message);
  }
  clearTimeout(to);

  const msgs: any[] = session.messages ?? [];
  const assistantMsgs = msgs.filter((m) => m?.role === "assistant");
  const firstAssistant = assistantMsgs[0];
  const firstAssistantToolCalls = (firstAssistant?.content ?? []).filter((c: any) => c?.type === "toolCall").map((c: any) => c?.name);
  const firstAssistantText = (firstAssistant?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c?.text).join("").slice(0, 80);
  const anyToolCall = msgs.some((m) => m?.role === "assistant" && (m?.content ?? []).some((c: any) => c?.type === "toolCall"));

  console.log(`[spike] assistant turns: ${assistantMsgs.length}`);
  console.log(`[spike] FIRST assistant message: toolCalls=${JSON.stringify(firstAssistantToolCalls)} text=${JSON.stringify(firstAssistantText)}`);
  console.log(`[spike] anyToolCall (any turn): ${anyToolCall}`);

  // DECISIVE: the FIRST assistant message contains a toolCall → tool_choice:"required"
  // reached the provider and forced a tool call on turn 1 (before any enforcer reminder).
  assert.ok(
    firstAssistantToolCalls.length > 0,
    "Spike-G1 PASS: tool_choice:'required' reached the provider → model forced to call a tool on turn 1 despite the task forbidding tools. G-OUT-2 is implementable via before_provider_request (no pi-core change).",
  );
  console.log("✓ Spike-G1 PASS + G-OUT-2 LIVE: tool_choice:'required' injected via before_provider_request reached the provider and forced a tool call on turn 1 (task said reply DONE, no tools).");
}

main().catch((e) => {
  console.error("SPIKE RESULT: tool_choice did NOT force a tool call on turn 1 — either pi stripped it during provider serialization, or the handler didn't fire. G-OUT-2 reverts to fatal-requires-pi-core (escalated); the production-verified reactive enforcer stays.");
  console.error("DETAIL:", e);
  process.exit(2);
});
