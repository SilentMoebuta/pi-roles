// G-LIV-1: liveness safety net must NOT false-abort a child that is mid-way
// through a long tool execution. The bug: `lastActivity` resets ONLY on
// `turn_end`, so a tool running longer than `livenessMs` (with no `turn_end`)
// trips the liveness timer and aborts a HEALTHY child. A real build / long bash
// op exceeds the 300_000ms default is rare, but a small `livenessMs` (role-tuned)
// false-aborts any multi-second tool. SOTA: LangGraph `Runtime.heartbeat()` /
// `TimeoutPolicy(refresh_on="heartbeat")` — activity mid-turn refreshes liveness.
//
// Fix: PAUSE the liveness check while a tool is executing (tool_execution_start
// → paused; tool_execution_end → resume + reset). The agent is waiting on an
// external op, not hung. A hung PROVIDER (no events at all) is still caught
// (toolInProgress stays false → liveness fires) — the true-positive is preserved.
//
// Verified against pi core (agent-session.js _handleAgentEvent): session.subscribe
// DOES receive tool_execution_start/end (the raw event is emitted to subscribers
// for all event types, not just pi.on). So handling them in the runner's
// subscribe listener is sound in prod (the live probe confirms end-to-end).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentSession, type SubagentEvent } from "../src/subagent/runner";

function makeSession(): SubagentSession & { emit(e: SubagentEvent | any): void; resolvePrompt(): void; } {
  const listeners: Array<(e: any) => void> = [];
  let resolvePrompt: () => void = () => {};
  const hang = new Promise<void>((r) => { resolvePrompt = r; });
  return {
    subscribe: (l: (e: any) => void) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { resolvePrompt(); },
    prompt: async () => { await hang; listeners.forEach((l) => l({ type: "agent_end" })); },
    emit: (e: any) => listeners.forEach((l) => l(e)),
    resolvePrompt,
  } as any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT: " + msg)), ms))]);

describe("runSubagent — G-LIV-1: liveness must not false-abort during a long tool execution", () => {
  it("a tool execution longer than livenessMs does NOT trip liveness (agent waits on tool, not hung)", async () => {
    const session = makeSession();
    const livenessMs = 50;
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs, pollMs: 20 });
    // Tool runs 3x livenessMs. BUG: liveness fires mid-tool (lastActivity only
    // resets on turn_end) → abort "liveness". FIX: paused during tool execution.
    session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 1" } });
    await sleep(livenessMs * 3); // 150ms — well past livenessMs=50
    session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "done", isError: false });
    session.emit({ type: "turn_end" });
    session.resolvePrompt();
    const outcome = await withTimeout(runP, 2000, "runner did not complete after long tool execution");
    assert.notEqual(outcome.reason, "liveness", "tool execution must not false-abort liveness (G-LIV-1)");
    assert.equal(outcome.status, "completed", "child completes after a long tool execution");
  });

  it("message_update (assistant streaming) refreshes liveness — a long generation is not a false abort either", async () => {
    const session = makeSession();
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 50, pollMs: 20 });
    // Model streams token batches (message_update) over >livenessMs before turn_end.
    // A single long generation with frequent updates must NOT false-abort.
    for (let i = 0; i < 5; i++) {
      await sleep(20);
      session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "tok" }] } });
    }
    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    session.emit({ type: "turn_end" });
    session.resolvePrompt();
    const outcome = await withTimeout(runP, 2000, "runner did not complete after a long generation");
    assert.notEqual(outcome.reason, "liveness", "message_update must refresh liveness (G-LIV-1)");
    assert.equal(outcome.status, "completed");
  });

  it("REGRESSION: a hung provider with NO tool/message events still trips liveness (true-positive preserved)", async () => {
    const session = makeSession();
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 50, pollMs: 20 });
    const outcome = await withTimeout(runP, 2000, "hung provider never aborted (liveness broken)");
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "liveness", "true-positive hung provider still caught");
  });
});
