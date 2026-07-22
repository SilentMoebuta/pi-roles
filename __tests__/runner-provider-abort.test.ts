import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentSession } from "../src/subagent/runner";

// Provider-abort detection: when the LLM provider aborts mid-generation (e.g.
// upstream connection reset on a long response), the assistant message arrives
// with stopReason "aborted" (or "error") but the runner's own abortReason stays
// null (it wasn't a liveness/step-limit/doom-loop/caller abort). Without
// detection, outcome.status = "completed" even though the child never called
// report_role_result, so spawn_role returns an empty result and the parent hangs.
//
// Fix: track the last assistant stopReason; if prompt resolves with
// abortReason===null but the last assistant message was aborted/errored, mark
// the outcome as aborted with reason "provider-abort" so P2-4 retry can fire.

type Ev =
  | { type: "message_end"; message: { role: string; stopReason?: string; content: Array<{ type: string; text?: string }> } }
  | { type: "turn_end" }
  | { type: "agent_end" };

function makeProviderAbortSession(opts: { assistantText?: string; stopReason?: string }) {
  const listeners: Array<(e: Ev) => void> = [];
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => {},
    prompt: async () => {
      // One turn: assistant message with stopReason "aborted" (provider reset).
      listeners.forEach((l) => l({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: opts.stopReason ?? "aborted",
          content: [{ type: "text", text: opts.assistantText ?? "partial response before abort" }],
        },
      }));
      listeners.forEach((l) => l({ type: "turn_end" }));
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session };
}

describe("runSubagent - provider-abort detection", () => {
  it("provider abort (stopReason=aborted, no runner abortReason) -> outcome aborted reason provider-abort", async () => {
    const fake = makeProviderAbortSession({ stopReason: "aborted", assistantText: "partial" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "provider-abort");
    assert.equal(out.finalText, "partial");
    assert.equal(out.turnCount, 1);
  });

  it("provider error (stopReason=error) -> outcome aborted reason provider-abort", async () => {
    const fake = makeProviderAbortSession({ stopReason: "error", assistantText: "" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "provider-abort");
  });

  it("normal completion (stopReason=stop) -> outcome completed (no false positive)", async () => {
    const fake = makeProviderAbortSession({ stopReason: "stop", assistantText: "all done" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "completed");
    assert.equal(out.reason, undefined);
    assert.equal(out.finalText, "all done");
  });

  it("toolUse stopReason (normal tool call) -> outcome completed (no false positive)", async () => {
    const fake = makeProviderAbortSession({ stopReason: "toolUse", assistantText: "calling tool" });
    const out = await runSubagent(fake.session, "task", { maxTurns: 10 });
    assert.equal(out.status, "completed");
    assert.equal(out.reason, undefined);
  });

  it("runner step-limit takes precedence over provider-abort", async () => {
    // If the runner itself aborts (step-limit), that reason wins over provider-abort.
    const listeners: Array<(e: Ev) => void> = [];
    let aborted = false;
    const session: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: () => {},
      abort: () => { aborted = true; },
      prompt: async () => {
        for (let i = 0; i < 5; i++) {
          if (aborted) break;
          listeners.forEach((l) => l({
            type: "message_end",
            message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: `t${i}` }] },
          }));
          listeners.forEach((l) => l({ type: "turn_end" }));
        }
        listeners.forEach((l) => l({ type: "agent_end" }));
      },
    };
    const out = await runSubagent(session, "task", { maxTurns: 2 });
    assert.equal(out.status, "aborted");
    assert.equal(out.reason, "step-limit");
  });
});
