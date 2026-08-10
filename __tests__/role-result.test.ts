import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createRoleResultEnvelope,
  parseRoleResultEnvelope,
  roleResultRef,
  verifyRoleResultRef,
} from "../src/role-result";

describe("typed role result envelope", () => {
  it("round-trips a completed structured payload and verifies its reference", () => {
    const envelope = createRoleResultEnvelope({
      agentId: "sub-1",
      role: "goal-reviewer",
      status: "completed",
      payload: { decision: "accept", findings: [], artifacts: [] },
      turnCount: 4,
      recordedAt: 1_000,
    });
    const parsed = parseRoleResultEnvelope(envelope);
    assert.deepEqual(parsed, envelope);
    assert.equal(verifyRoleResultRef(parsed, roleResultRef(envelope)), true);
    assert.equal(envelope.error, null);
  });

  it("classifies provider aborts as typed retryable errors", () => {
    const envelope = createRoleResultEnvelope({
      agentId: "sub-2",
      role: "goal-reviewer",
      status: "aborted",
      reason: "provider-abort",
      turnCount: 1,
      recordedAt: 2_000,
    });
    assert.equal(envelope.error?.code, "provider_abort");
    assert.equal(envelope.error?.retryable, true);
    assert.deepEqual(parseRoleResultEnvelope(envelope), envelope);
  });

  it("rejects a payload changed after the envelope digest was recorded", () => {
    const envelope = createRoleResultEnvelope({
      agentId: "sub-3",
      role: "goal-reviewer",
      status: "completed",
      payload: { decision: "accept", findings: [], artifacts: [] },
      recordedAt: 3_000,
    });
    (envelope.payload as Record<string, unknown>).decision = "revise";
    assert.throws(() => parseRoleResultEnvelope(envelope), /digest mismatch/);
  });
});
