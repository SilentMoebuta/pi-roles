import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentEvent, type SubagentSession } from "../src/subagent/runner";

function fakeSession() {
  const listeners: Array<(event: SubagentEvent) => void> = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let aborted = false;
  const session: SubagentSession = {
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; release(); },
    prompt: async () => { await wait; listeners.forEach((listener) => listener({ type: "agent_end" })); },
  };
  return { session, emit: (event: SubagentEvent) => listeners.forEach((listener) => listener(event)), release, wasAborted: () => aborted };
}

describe("subagent progress bridge", () => {
  it("emits sanitized tool and completion lifecycle events", async () => {
    const f = fakeSession();
    const events: any[] = [];
    const run = runSubagent(f.session, "task", { livenessMs: 0, onProgress: (event) => events.push(event) });
    f.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/secret" } });
    f.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "secret", isError: false });
    f.emit({ type: "turn_end" });
    f.release();
    const outcome = await run;
    assert.equal(outcome.status, "completed");
    assert.ok(events.some((event) => event.phase === "tool" && event.tool === "read"));
    assert.ok(events.some((event) => event.phase === "completed"));
    assert.equal("args" in events[0], false, "progress must not expose tool arguments");
  });
});
