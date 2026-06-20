// G-OUT-2: proactive output-contract enforcement via before_provider_request.
// The handler injects tool_choice:"required" for role-subagent sessions (child,
// parentSession header present) so the model is forced to call a tool each turn
// and cannot text-only-finish without calling report_role_result. The main
// session is never touched (needs text-only replies). Complements the reactive
// P0-4 agent_end enforcer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeOutputContractProactiveHandler } from "../src/subagent/output-contract-proactive";

describe("output-contract-proactive — G-OUT-2 before_provider_request tool_choice forcing", () => {
  it("forces tool_choice:'required' for a role subagent (parentSession present)", () => {
    const h = makeOutputContractProactiveHandler();
    const out = h(
      { type: "before_provider_request", payload: { messages: [], model: "x" } },
      { sessionManager: { getHeader: () => ({ parentSession: "parent-1" }) } },
    );
    assert.deepEqual(out, { messages: [], model: "x", tool_choice: "required" });
  });

  it("does NOT touch the main session payload (no parentSession) — text-only replies preserved", () => {
    const h = makeOutputContractProactiveHandler();
    const payload = { messages: [], model: "x" };
    const out = h(
      { type: "before_provider_request", payload },
      { sessionManager: { getHeader: () => ({}) } },
    );
    assert.equal(out, undefined, "main session payload must be unchanged");
  });

  it("does NOT touch when getHeader is missing/malformed (no-op, don't risk the request)", () => {
    const h = makeOutputContractProactiveHandler();
    assert.equal(h({ type: "before_provider_request", payload: { a: 1 } }, {}), undefined);
    assert.equal(h({ type: "before_provider_request", payload: { a: 1 } }, { sessionManager: {} }), undefined);
    assert.equal(h({ type: "before_provider_request", payload: { a: 1 } }, { sessionManager: { getHeader: () => { throw new Error("boom"); } } }), undefined);
  });

  it("preserves existing payload fields and only adds tool_choice", () => {
    const h = makeOutputContractProactiveHandler();
    const out = h(
      { type: "before_provider_request", payload: { messages: [{ role: "user" }], tools: [{ type: "function" }], temperature: 0.7 } },
      { sessionManager: { getHeader: () => ({ parentSession: "p" }) } },
    );
    assert.equal(out.messages.length, 1);
    assert.equal(out.tools.length, 1);
    assert.equal(out.temperature, 0.7);
    assert.equal(out.tool_choice, "required");
  });

  it("supports a role-specific tool_choice override (e.g. force a specific tool)", () => {
    const h = makeOutputContractProactiveHandler({ toolChoice: { type: "function", function: { name: "report_role_result" } } });
    const out = h(
      { type: "before_provider_request", payload: { messages: [] } },
      { sessionManager: { getHeader: () => ({ parentSession: "p" }) } },
    );
    assert.deepEqual(out.tool_choice, { type: "function", function: { name: "report_role_result" } });
  });
});
