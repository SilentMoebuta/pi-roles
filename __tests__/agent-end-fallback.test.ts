import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentEndFallback, type FallbackDeps } from "../src/subagent/agent-end-fallback";

// agent_end fallback: if a role subagent finished WITHOUT calling report_role_result
// (model ignored the prompt instruction), the system constructs a fallback payload
// from the last assistant message so spawn_role still gets a structured result.
// Contract reliability comes from the MECHANISM, not model compliance.

interface Msg { role: string; content: Array<{ type: string; text?: string }> }

function deps(opts: { payloads?: Map<string, any>; reported?: Set<string>; activeRole?: Map<string, string>; sessionFile?: string }): { handler: any; d: FallbackDeps } {
  const d: FallbackDeps = {
    payloads: opts.payloads ?? new Map(),
    reported: opts.reported ?? new Set(),
    activeRole: opts.activeRole ?? new Map(),
    getSessionFile: (ctx: any) => opts.sessionFile ?? ctx?.sessionFile ?? "/tmp/child.jsonl",
  };
  return { handler: makeAgentEndFallback(d), d };
}

function assistantMsg(text: string): Msg {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("agent_end fallback", () => {
  it("does nothing when the role already reported (payload exists) — no overwrite", () => {
    const payloads = new Map([["/tmp/c.jsonl", { findings: ["real"], artifacts: ["a.ts"] }]]);
    const { handler } = deps({ payloads, sessionFile: "/tmp/c.jsonl" });
    handler({ type: "agent_end", messages: [assistantMsg("late text")] }, {});
    assert.deepEqual(payloads.get("/tmp/c.jsonl"), { findings: ["real"], artifacts: ["a.ts"] });
  });

  it("constructs fallback payload from last assistant message when role didn't report", () => {
    const payloads = new Map<string, any>();
    const activeRole = new Map([ ["/tmp/c.jsonl", "reviewer"] ]);
    const { handler } = deps({ payloads, activeRole, sessionFile: "/tmp/c.jsonl" });
    handler({ type: "agent_end", messages: [assistantMsg("first"), assistantMsg("final answer text")] }, {});
    const p = payloads.get("/tmp/c.jsonl");
    assert.ok(p, "fallback payload created");
    assert.deepEqual(p, { findings: ["final answer text"], artifacts: [] });
  });

  it("uses an empty findings array when no assistant message exists (e.g. error run)", () => {
    const payloads = new Map<string, any>();
    const activeRole = new Map([ ["/tmp/c.jsonl", "reviewer"] ]);
    const { handler } = deps({ payloads, activeRole, sessionFile: "/tmp/c.jsonl" });
    handler({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, {});
    const p = payloads.get("/tmp/c.jsonl");
    assert.deepEqual(p, { findings: [], artifacts: [] });
  });

  it("skips non-role sessions (no activeRole entry) — main agent end doesn't create a payload", () => {
    const payloads = new Map<string, any>();
    const activeRole = new Map<string, string>(); // empty — not a role session
    const { handler } = deps({ payloads, activeRole, sessionFile: "/tmp/main.jsonl" });
    handler({ type: "agent_end", messages: [assistantMsg("main agent done")] }, {});
    assert.equal(payloads.size, 0, "no fallback for non-role (main) session");
  });

  it("only the LAST assistant message is captured (not earlier ones)", () => {
    const payloads = new Map<string, any>();
    const activeRole = new Map([["/tmp/c.jsonl", "reviewer"]]);
    const { handler } = deps({ payloads, activeRole, sessionFile: "/tmp/c.jsonl" });
    handler({ type: "agent_end", messages: [assistantMsg("turn1"), assistantMsg("turn2"), assistantMsg("turn3 final")] }, {});
    const p = payloads.get("/tmp/c.jsonl");
    assert.deepEqual(p, { findings: ["turn3 final"], artifacts: [] });
  });

  it("concatenates multiple text blocks in the last assistant message", () => {
    const payloads = new Map<string, any>();
    const activeRole = new Map([["/tmp/c.jsonl", "reviewer"]]);
    const { handler } = deps({ payloads, activeRole, sessionFile: "/tmp/c.jsonl" });
    const last = { role: "assistant", content: [{ type: "text", text: "part1 " }, { type: "text", text: "part2" }] };
    handler({ type: "agent_end", messages: [last] }, {});
    const p = payloads.get("/tmp/c.jsonl");
    assert.deepEqual(p, { findings: ["part1 part2"], artifacts: [] });
  });

  it("marks the session as reported so report_role_result later (if model calls it late) sees duplicate", () => {
    const payloads = new Map<string, any>();
    const reported = new Set<string>();
    const activeRole = new Map([["/tmp/c.jsonl", "reviewer"]]);
    const { handler, d } = deps({ payloads, reported, activeRole, sessionFile: "/tmp/c.jsonl" });
    handler({ type: "agent_end", messages: [assistantMsg("done")] }, {});
    assert.ok(d.reported.has("/tmp/c.jsonl"), "session marked reported after fallback");
  });

  it("no sessionFile resolvable → no-op (cannot key the payload)", () => {
    const payloads = new Map<string, any>();
    const { handler } = deps({ payloads, sessionFile: undefined });
    handler({ type: "agent_end", messages: [assistantMsg("x")] }, {});
    assert.equal(payloads.size, 0);
  });
});
