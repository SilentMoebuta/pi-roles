import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAutoCompactHandler } from "../src/subagent/auto-compact-handler";

// P1-5 PROD-WIRING regression guard (the bug the live probe found).
//
// In production a child subagent loads its OWN pi-roles instance → its OWN
// reportState (empty). Nobody populates the child's activeRole (the parent's
// onSessionCreated writes to the PARENT's reportState; the child's
// session_start handler only does setActiveTools). So getRole(sessionFile)
// returns undefined for the child. The OLD gating (isRoleSession = !!getRole)
// therefore made the handler a no-op for EVERY child — the researcher
// maxTurns:9999 overflow cliff was NOT prevented.
//
// The fix: gate isRoleSession on the session header's parentSession (set by
// spawnRole for every child, readable from the child's own sessionManager —
// like P0-4's enforcer). Role name stays best-effort via getRole; when undefined
// (the child case) the GENERIC compaction prompt is used (role-specific prompts
// are unreachable from the child without a pi-core session-header change).
//
// This test mirrors PROD: empty activeRole (getRole undefined) + parentSession
// header present + high tokens → compaction MUST fire (generic prompt).

describe("makeAutoCompactHandler — P1-5 prod-wiring (header gating)", () => {
  it("compacts a child session whose activeRole is EMPTY but parentSession header is set (prod reality)", () => {
    const compactions: string[] = [];
    // PROD wiring: getRole reads activeRole, which is EMPTY for the child's own
    // instance (nobody populates it). This is the case the old gating got wrong.
    const handler = makeAutoCompactHandler({
      getRole: () => undefined,
      contextWindow: 100_000,
      thresholdPct: 0.70, // threshold = 70k
    });
    handler(
      { type: "turn_end" },
      {
        // The child's sessionManager HAS the parentSession header (spawnRole set
        // it via newSession({parentSession})). This is the gate the fix uses.
        sessionManager: { getSessionFile: () => "/tmp/child.jsonl", getHeader: () => ({ parentSession: "probe-parent" }) },
        compact: (o) => { compactions.push(o.customInstructions ?? ""); o.onComplete?.(); },
        getContextUsage: () => ({ tokens: 80_000 }),
      },
    );
    assert.equal(compactions.length, 1, "PROD: child with empty activeRole + parentSession header MUST compact (header gating)");
    assert.match(compactions[0], /key findings/i, "falls back to the GENERIC prompt (role name unreachable from child)");
  });

  it("does NOT compact the MAIN session (no parentSession header)", () => {
    const compactions: string[] = [];
    const handler = makeAutoCompactHandler({
      getRole: () => undefined,
      contextWindow: 100_000,
      thresholdPct: 0.70,
    });
    handler(
      { type: "turn_end" },
      {
        // Main session: no parentSession header.
        sessionManager: { getSessionFile: () => "/tmp/main.jsonl", getHeader: () => undefined },
        compact: (o) => { compactions.push(o.customInstructions ?? ""); o.onComplete?.(); },
        getContextUsage: () => ({ tokens: 95_000 }),
      },
    );
    assert.equal(compactions.length, 0, "main session (no parentSession) not compacted — only role subagents");
  });

  it("role-specific prompt STILL applies when getRole resolves (parent-side / shared-state case)", () => {
    const compactions: string[] = [];
    const handler = makeAutoCompactHandler({
      getRole: () => "researcher", // role name available (e.g. parent session, or future role-header)
      contextWindow: 100_000,
      thresholdPct: 0.70,
    });
    handler(
      { type: "turn_end" },
      {
        sessionManager: { getSessionFile: () => "/tmp/r.jsonl", getHeader: () => ({ parentSession: "p" }) },
        compact: (o) => { compactions.push(o.customInstructions ?? ""); o.onComplete?.(); },
        getContextUsage: () => ({ tokens: 80_000 }),
      },
    );
    assert.equal(compactions.length, 1);
    assert.match(compactions[0], /citation/i, "role-specific prompt preserved when role name is reachable");
  });
});
