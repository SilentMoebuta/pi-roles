import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runSubagent, type SubagentSession, type SubagentEvent } from "../src/subagent/runner";

const RUNNER_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "subagent", "runner.ts"), "utf8");

// T1-2 (P1-4): doom-loop + liveness are dead code in prod — NO caller enables
// them, so a subagent whose provider hangs (no turn_end) never increments
// turnCount, maxTurns never fires, and livenessMs is disabled → runSubagent
// awaits session.prompt() FOREVER. For a background spawn that holds a
// concurrency slot; 5 hung bg = total deadlock (maxConcurrentSpawns=5).
// Also: doom-loop tracked assistant TEXT, but SOTA (OpenCode) tracks
// tool-name+input-hash — a role stuck calling the same failing tool with varied
// text is NOT caught by the text signal.

function makeSession(): SubagentSession & { emit(e: SubagentEvent): void; resolvePrompt(): void; } {
  const listeners: Array<(e: SubagentEvent) => void> = [];
  let resolvePrompt: () => void = () => {};
  const hang = new Promise<void>((r) => { resolvePrompt = r; });
  let aborted = false;
  return {
    subscribe: (l: (e: SubagentEvent) => void) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; resolvePrompt(); },
    prompt: async () => { await hang; listeners.forEach((l) => l({ type: "agent_end" })); },
    emit: (e: SubagentEvent) => listeners.forEach((l) => l(e)),
    resolvePrompt,
  } as any;
}

// Race a promise against a timeout so a hung runner FAILS cleanly instead of
// stalling the suite (the T1-2 bug makes the runner hang forever).
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("TIMEOUT: " + msg)), ms)),
  ]);
}

describe("runSubagent — liveness + doom-loop defaults (T1-2)", () => {
  it("a hung session (no turn_end ever) aborts via liveness instead of hanging forever", async () => {
    const session = makeSession();
    // Simulate a provider that starts prompt but never emits turn_end
    // (network stall / hung API). With livenessMs set, the runner must abort via
    // the liveness safety net, not hang forever. (The DEFAULT is 300_000ms — too
    // slow to observe in a unit test; this asserts the mechanism fires. The
    // default-on behavior is exercised by the constant assertion below + code review.)
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 50 });
    const outcome = await withTimeout(runP, 2000, "hung session never aborted (T1-2: liveness mechanism broken)");
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "liveness", "aborted by liveness safety net, not by hanging forever");
  });

  it("livenessMs defaults to 300_000 (5 min) when omitted (T1-2 default-on)", () => {
    // The default constant: a hung provider holds a slot for at most 5 min
    // (generous per Hermes lesson), NOT forever. Observable in prod as a bounded
    // recovery from a hung bg child (5 hung bg = deadlock under the OLD disabled default).
    assert.match(RUNNER_SRC, /opts\.livenessMs === undefined \? 300_000/, "livenessMs defaults to 300_000 (T1-2)");
    assert.doesNotMatch(RUNNER_SRC, /opts\.doomLoop \?\? false/, "doomLoop no longer defaults false");
    assert.match(RUNNER_SRC, /opts\.doomLoop \?\? true/, "doomLoop defaults true (T1-2)");
  });

  it("explicit livenessMs:0 still disables (opt-out honored)", async () => {
    const session = makeSession();
    // With livenessMs:0, a hung session MUST hang (opt-out honored) — but we
    // don't actually wait for the hang; we assert the runner doesn't abort
    // within a window where liveness=50 WOULD have fired.
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 0 });
    // If liveness respected the explicit 0, outcome won't resolve from liveness.
    // Race against a short window — liveness=0 means no liveness abort within it.
    const result = await Promise.race([
      runP.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("still-hanging"), 120)),
    ]);
    assert.equal(result, "still-hanging", "livenessMs:0 disables liveness (opt-out honored)");
    // (don't await runP — leave it hanging; test process exits)
  });

  it("doom-loop: 3 consecutive identical tool-call blocks trigger abort (tool+input signal, default ON)", async () => {
    const session = makeSession();
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 0 });
    // Emit a toolCall + turn_end three times with identical tool name + args.
    // The OLD code tracked assistant TEXT (empty here) → would NOT fire.
    const toolEvents = (): SubagentEvent[] => [
      { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } },
      { type: "turn_end" },
    ];
    for (const e of toolEvents()) session.emit(e);
    for (const e of toolEvents()) session.emit(e);
    for (const e of toolEvents()) session.emit(e); // 3rd identical → doom-loop
    const outcome = await withTimeout(runP, 2000, "doom-loop not firing on identical tool calls (T1-2: signal was text not tool+input)");
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "doom-loop", "aborted by tool+input doom-loop, default ON");
  });

  it("doom-loop does NOT fire when tool args differ each turn", async () => {
    const session = makeSession();
    const runP = runSubagent(session, "task", { maxTurns: 3, livenessMs: 0 });
    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } });
    session.emit({ type: "turn_end" });
    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run build" } }] } });
    session.emit({ type: "turn_end" });
    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run lint" } }] } });
    session.emit({ type: "turn_end" });
    const outcome = await withTimeout(runP, 2000, "doom-loop false-abort on varied tool calls");
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "step-limit", "aborted by step-limit, NOT doom-loop (args varied)");
  });

  it("explicit doomLoop:false disables doom-loop (opt-out honored)", async () => {
    const session = makeSession();
    const runP = runSubagent(session, "task", { maxTurns: 9999, livenessMs: 0, doomLoop: false });
    const toolEvent = (): SubagentEvent => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] } });
    session.emit(toolEvent()); session.emit({ type: "turn_end" });
    session.emit(toolEvent()); session.emit({ type: "turn_end" });
    session.emit(toolEvent()); session.emit({ type: "turn_end" });
    const result = await Promise.race([
      runP.then((o) => o.status),
      new Promise((r) => setTimeout(() => r("still-running"), 120)),
    ]);
    assert.equal(result, "still-running", "doomLoop:false disables doom-loop (opt-out honored)");
  });
});
