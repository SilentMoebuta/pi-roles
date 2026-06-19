import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentSession } from "../src/subagent/runner";

// Runner drives a (possibly fake) session: subscribes, counts turn_end, enforces
// maxTurns (primary) + liveness (generous safety net) + caller-signal abort.
// Determined by pi primitive verification (research note Appendix A): prompt()
// blocks until agent_end; turn_end = one turn; session.abort() is graceful.
//
// The fake session emits the same events real pi emits, so runner logic is
// exercised without an LLM. Real createAgentSession is used only in the
// end-to-end smoke (criterion 4).

type Ev =
  | { type: "message_end"; message: { role: string; content: Array<{ type: string; text?: string }> } }
  | { type: "turn_end" }
  | { type: "agent_end" };

function makeFakeSession(opts: {
  turns: number;             // turn_end events to emit before natural completion
  assistantText?: string;    // text in the last assistant message_end
  hangUntilAbort?: boolean;  // prompt never resolves unless abort() called (liveness test)
  throwInPrompt?: string;    // prompt() throws this message
}) {
  const listeners: Array<(e: Ev) => void> = [];
  let aborted = false;
  let promptResolver: (() => void) | null = null;
  const hangPromise = new Promise<void>((r) => { promptResolver = r; });
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; promptResolver?.(); },
    prompt: async () => {
      if (opts.throwInPrompt) throw new Error(opts.throwInPrompt);
      for (let i = 0; i < opts.turns; i++) {
        if (aborted) break;
        listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: opts.assistantText ?? `turn${i}` }] } }));
        listeners.forEach((l) => l({ type: "turn_end" }));
      }
      if (opts.hangUntilAbort) { await hangPromise; }
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session, wasAborted: () => aborted };
}

describe("runSubagent", () => {
  it("natural completion: returns completed with last assistant text", async () => {
    const fake = makeFakeSession({ turns: 2, assistantText: "all done" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "completed");
    assert.equal(out.finalText, "all done");
    assert.equal(out.turnCount, 2);
    assert.equal(fake.wasAborted(), false);
  });

  it("maxTurns cutoff: aborts at limit, status aborted reason step-limit", async () => {
    const fake = makeFakeSession({ turns: 10, assistantText: "still going" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 2 });
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "step-limit");
    assert.equal(out.turnCount, 2);
    assert.equal(fake.wasAborted(), true);
  });

  it("maxTurns undefined/0 = unlimited (no step-limit abort)", async () => {
    const fake = makeFakeSession({ turns: 5 });
    const out = await runSubagent(fake.session, "task", {});
    assert.equal(out.status, "completed");
    assert.equal(out.turnCount, 5);
    assert.equal(fake.wasAborted(), false);
  });

  it("caller signal abort: aborts session, status aborted reason caller-abort", async () => {
    // Slow fake so the 7ms abort lands mid-run (synchronous fakes finish first).
    const listeners: Array<(e: Ev) => void> = [];
    let aborted = false;
    const slowSession: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: () => {},
      abort: () => { aborted = true; },
      prompt: async () => {
        for (let i = 0; i < 20; i++) {
          if (aborted) break;
          await new Promise((r) => setTimeout(r, 5));
          listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `t${i}` }] } }));
          listeners.forEach((l) => l({ type: "turn_end" }));
        }
        listeners.forEach((l) => l({ type: "agent_end" }));
      },
    };
    const ac = new AbortController();
    const p = runSubagent(slowSession, "task", { maxTurns: 100, signal: ac.signal });
    setTimeout(() => ac.abort(), 7);
    const out = await p;
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "caller-abort");
    assert.equal(aborted, true);
  });

  it("liveness: no turn_end within window → abort, reason liveness", async () => {
    const fake = makeFakeSession({ turns: 0, hangUntilAbort: true });
    const out = await runSubagent(fake.session, "task", { maxTurns: 100, livenessMs: 40, pollMs: 10 });
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "liveness");
    assert.equal(fake.wasAborted(), true);
  });

  it("liveness disabled by default (0 = no timeout); a slow-but-progressing run is not killed", async () => {
    // turns arrive but prompt resolves quickly; no liveness configured → no abort
    const fake = makeFakeSession({ turns: 1 });
    const out = await runSubagent(fake.session, "task", {});
    assert.equal(out.status, "completed");
    assert.equal(fake.wasAborted(), false);
  });

  it("liveness resets on each turn_end (progressing run not killed)", async () => {
    // A custom fake that spaces turns wider than poll but within liveness
    const listeners: Array<(e: Ev) => void> = [];
    let aborted = false;
    const session: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: () => {},
      abort: () => { aborted = true; },
      prompt: async () => {
        for (let i = 0; i < 3; i++) {
          if (aborted) break;
          await new Promise((r) => setTimeout(r, 15));
          listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `t${i}` }] } }));
          listeners.forEach((l) => l({ type: "turn_end" }));
        }
        listeners.forEach((l) => l({ type: "agent_end" }));
      },
    };
    const out = await runSubagent(session, "task", { maxTurns: 100, livenessMs: 50, pollMs: 10 });
    assert.equal(out.status, "completed");
    assert.equal(out.turnCount, 3);
    assert.equal(aborted, false);
  });

  it("prompt throws → status error with message", async () => {
    const fake = makeFakeSession({ turns: 0, throwInPrompt: "provider down" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "error");
    assert.match(out.reason ?? "", /provider down/);
  });

  it("finalText falls back to last assistant text even when aborted at step-limit", async () => {
    const fake = makeFakeSession({ turns: 10, assistantText: "partial work" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 1 });
    assert.equal(out.status, "aborted");
    assert.equal(out.finalText, "partial work");
  });
});
