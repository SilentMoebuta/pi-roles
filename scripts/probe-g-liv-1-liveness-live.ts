// probe-g-liv-1-liveness-live.ts — G-LIV-1 live e2e proof.
//
// Spawns a REAL child session via real createAgentSession (default resourceLoader
// loads pi-roles) + real testprov/test-model. The child is given a custom `sleep_tool`
// that sleeps 15s, plus report_role_result (so the output-contract enforcer is
// satisfied and the child stops cleanly in ~2 turns — minimal inter-message
// latency exposure). We drive the child via the REAL runSubagent with
// livenessMs=6000 (6s — well above normal LLM inter-message latency) but 2.5x
// SMALLER than the tool's 15s sleep.
//
// DISTINGUISHES fix vs no-op (the P1-5 silent-no-op pattern):
// - If the fix WORKS: liveness PAUSES during the 15s tool → no abort → child completes.
// - If the fix is a NO-OP (session.subscribe did NOT deliver tool_execution_* to
//   the runner): the 15s tool (>6s livenessMs) trips liveness → abort "liveness".
// Normal inter-message gaps (<6s) do NOT trip livenessMs=6000, so the only thing
// that could trip it is the 15s tool — which the fix pauses. Clean isolation.
//
// DECISIVE FACT (logged): session.subscribe delivers tool_execution_start/end to
// the runner's listener in a REAL child (agent-session.js _handleAgentEvent emits
// the raw event to subscribers for all types). If a shape mismatch made the fix a
// silent no-op, sawToolExecStart/End would be false OR liveness would abort.
//
// Independent node process → fresh disk code (bypasses parent-pi module cache).
// Run: npx tsx scripts/probe-g-liv-1-liveness-live.ts
import { createAgentSession, SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as assert from "node:assert/strict";
import { runSubagent } from "../src/subagent/runner";
import { makeReportTool, type ReportState } from "../src/report-tool";
import { DEFAULT_REPORT_SCHEMA } from "../src/contract";

const LIVENESS_MS = 6000;      // > normal LLM inter-message latency; < tool sleep
const TOOL_SLEEP_MS = 15000;   // 2.5x livenessMs — would trip pre-fix / no-op
const MAX_TURNS = 6;
const TIMEOUT_MS = 180_000;

const sleepTool = defineTool({
  name: "sleep_tool",
  label: "Sleep Tool",
  description: "Sleeps for 15 seconds then returns. Call this exactly once.",
  parameters: Type.Object({}),
  async execute(_toolCallId: string, _params: Record<string, unknown>, signal: AbortSignal) {
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, TOOL_SLEEP_MS);
      if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    return { content: [{ type: "text" as const, text: `slept ${Date.now() - start}ms` }], details: { sleptMs: Date.now() - start } };
  },
});

async function main() {
  const cwd = "/tmp/pi-gliv1-cwd-" + Date.now();
  fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  const sm = SessionManager.create(cwd);
  sm.newSession({ parentSession: "probe-gliveliness-parent" });
  console.log("[probe] child sessionFile:", sm.getSessionFile());

  // report_role_result so the child satisfies the output contract + stops cleanly
  // (otherwise the P0-4 enforcer fires reminders → extra turns → latency exposure).
  const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
  const reportTool = makeReportTool({ state: reportState, schema: DEFAULT_REPORT_SCHEMA, failedStep: "probe" });

  console.log("[probe] createAgentSession (default resourceLoader loads pi-roles; default model = testprov/test-model)...");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: sm,
    tools: ["sleep_tool", "report_role_result"],
    customTools: [sleepTool as any, reportTool as any],
    thinkingLevel: "low",
  }) as any;

  await session.bindExtensions?.({ mode: "print" });
  console.log("[probe] active tools:", session.getActiveToolNames?.());

  // Log the event stream — tool_execution_* visibility is the decisive fact.
  const eventTypes: string[] = [];
  const toolExecTimestamps: number[] = [];
  const unsub = session.subscribe((e: any) => {
    eventTypes.push(e.type);
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end") toolExecTimestamps.push(Date.now());
  });

  const ac = new AbortController();
  const to = setTimeout(() => { console.error("[probe] TIMEOUT — aborting"); try { session.abort?.(); } catch {} ac.abort(); }, TIMEOUT_MS);

  // Task: call sleep_tool (15s > 6s liveness) then report + stop. Clean 2-turn flow.
  const task = "Call the sleep_tool exactly once. After it returns, call report_role_result with findings=[\"done\"] and artifacts=[]. Then stop.";
  console.log(`[probe] runSubagent(livenessMs=${LIVENESS_MS}, maxTurns=${MAX_TURNS}) — tool sleeps ${TOOL_SLEEP_MS}ms...`);
  const outcome = await runSubagent(session as any, task, { livenessMs: LIVENESS_MS, maxTurns: MAX_TURNS, pollMs: 1000, signal: ac.signal });
  clearTimeout(to);
  unsub();

  const msgs: any[] = session.messages ?? [];
  const sleepCalled = msgs.some((m) => m?.role === "assistant" && (m?.content ?? []).some((c: any) => c?.type === "toolCall" && c?.name === "sleep_tool"));
  const sawToolExecStart = eventTypes.includes("tool_execution_start");
  const sawToolExecEnd = eventTypes.includes("tool_execution_end");
  const toolWindowMs = toolExecTimestamps.length >= 2 ? (toolExecTimestamps[1] - toolExecTimestamps[0]) : 0;

  console.log(`[probe] RESULT: status=${outcome.status} reason=${outcome.reason ?? "-"} turnCount=${outcome.turnCount}`);
  console.log(`[probe] sleepCalled=${sleepCalled} sawToolExecStart=${sawToolExecStart} sawToolExecEnd=${sawToolExecEnd} toolWindowMs=${toolWindowMs}`);
  console.log(`[probe] event stream: ${eventTypes.join(",")}`);

  // DECISIVE FACT: session.subscribe delivers tool_execution_* in a real child.
  // If this fails, the runner's fix is a silent no-op (the P1-5 pattern).
  assert.ok(sawToolExecStart && sawToolExecEnd, "G-LIV-1 LIVE: session.subscribe must deliver tool_execution_start/end to the runner in a real child");
  assert.ok(sleepCalled, "G-LIV-1 LIVE: the child must have called sleep_tool (probe otherwise inconclusive)");

  // THE FIX: a 15s tool under 6s liveness must NOT false-abort. If the fix were
  // a no-op (events not delivered → toolInProgress never set), the 15s tool
  // (>6s livenessMs) would trip liveness here. The tool window (start→end) is
  // ~15s, confirming the long execution actually happened.
  assert.ok(toolWindowMs >= LIVENESS_MS, `G-LIV-1 LIVE: tool execution window (${toolWindowMs}ms) must exceed livenessMs (${LIVENESS_MS}ms) — else the probe does not exercise the bug`);
  assert.ok(
    !(outcome.status === "aborted" && outcome.reason === "liveness"),
    "G-LIV-1 LIVE: a tool execution > livenessMs must NOT false-abort (liveness paused during tool execution)",
  );

  console.log("✓ G-LIV-1 LIVE: real child ran a 15s tool under livenessMs=6000 with NO false liveness abort; tool_execution_* delivered to the runner's subscribe listener (fix is NOT a silent no-op).");
  if (outcome.status === "completed") console.log("✓ child completed normally.");
}

main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
