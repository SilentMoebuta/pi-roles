import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeOutputContractEnforcer } from "../src/subagent/output-contract-enforcer";

// P0-4: proactive output-contract enforcement (hybrid). A child-side agent_end
// handler scans event.messages for a report_role_result toolCall; if absent and
// retries<maxRetries, sends a reminder (deliverAs:'steer', triggerTurn:true) so
// the child gets another turn. extractReportPayload stays as the reactive fallback.

function harness(maxRetries = 2) {
  const reminders: string[] = [];
  const enforcer = makeOutputContractEnforcer({
    sendReminder: (text) => reminders.push(text),
    maxRetries,
  });
  const ctx = (parentSession?: string) => ({
    sessionManager: {
      getSessionFile: () => "/tmp/c.jsonl",
      getHeader: () => (parentSession ? { parentSession } : undefined),
    },
  });
  return { enforcer, reminders, ctx };
}

const noReportMessages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
const reportMessages = [{ role: "assistant", content: [{ type: "toolCall", name: "report_role_result" }] }];

describe("makeOutputContractEnforcer — P0-4 proactive enforcement", () => {
  it("reminds when a role session ends WITHOUT calling report_role_result", () => {
    const h = harness();
    h.enforcer({ type: "agent_end", messages: noReportMessages }, h.ctx("parent-session-file"));
    assert.equal(h.reminders.length, 1, "reminder sent on missing report_role_result");
    assert.match(h.reminders[0], /MUST call report_role_result/i);
  });

  it("does NOT remind when the child DID call report_role_result", () => {
    const h = harness();
    h.enforcer({ type: "agent_end", messages: reportMessages }, h.ctx("parent-session-file"));
    assert.equal(h.reminders.length, 0, "no reminder when contract satisfied");
  });

  it("does NOT remind the MAIN session (no parentSession header)", () => {
    const h = harness();
    h.enforcer({ type: "agent_end", messages: noReportMessages }, h.ctx(undefined));
    assert.equal(h.reminders.length, 0, "main session not reminded (only role subagents)");
  });

  it("stops reminding after maxRetries (bound — no infinite loop)", () => {
    const h = harness(2);
    h.enforcer({ type: "agent_end", messages: noReportMessages }, h.ctx("p"));
    h.enforcer({ type: "agent_end", messages: noReportMessages }, h.ctx("p"));
    h.enforcer({ type: "agent_end", messages: noReportMessages }, h.ctx("p")); // 3rd — over maxRetries
    assert.equal(h.reminders.length, 2, "stops after maxRetries=2 (no infinite loop)");
  });

  it("sendReminder failure does not crash agent_end (best-effort)", () => {
    const enforcer = makeOutputContractEnforcer({ sendReminder: () => { throw new Error("send failed"); }, maxRetries: 2 });
    const ctx = { sessionManager: { getSessionFile: () => "/tmp/c.jsonl", getHeader: () => ({ parentSession: "p" }) } };
    assert.doesNotThrow(() => enforcer({ type: "agent_end", messages: noReportMessages }, ctx), "best-effort: reminder failure swallowed");
  });
});
