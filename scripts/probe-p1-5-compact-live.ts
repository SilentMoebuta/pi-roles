// probe-p1-5-compact-live.ts — P1-5 e2e investigation + fix regression guard.
//
// HISTORY (what the live probe found): the P1-5 auto-compact handler was WIRED
// in index.ts (pi.on("turn_end", makeAutoCompactHandler(...))) and DISPATCHED on
// child sessions (proven live by probe-p0-4-contract-live.ts via the same
// child-side pi.on mechanism), BUT its gating was broken: isRoleSession read
// reportState.activeRole, which is empty for the child's OWN pi-roles instance
// (the parent's onSessionCreated writes to the PARENT's reportState; the child's
// session_start handler only does setActiveTools). So the handler was a no-op for
// EVERY child — the researcher maxTurns:9999 overflow cliff was NOT prevented.
// The unit test passed only because its harness populated activeRole
// (test/prod divergence).
//
// FIX: gate isRoleSession on the session header's parentSession (set by spawnRole
// for every child, readable from the child's own sessionManager — like P0-4's
// enforcer). Role name stays best-effort via getRole; when undefined (the child
// case) the GENERIC compaction prompt is used (role-specific prompts are
// unreachable from the child without a pi-core session-header change —
// SessionHeader has no role field).
//
// This probe reproduces PROD wiring (empty activeRole + parentSession header) and
// asserts the FIXED behavior: compaction now fires for a child, with the generic
// prompt. Run: npx tsx scripts/probe-p1-5-compact-live.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAutoCompactHandler } from "../src/subagent/auto-compact-handler";
import type { ReportState } from "../src/report-tool";

// Mirror index.ts wiring: getRole reads activeRole from a ReportState.
function wire(reportState: ReportState) {
  const compactions: string[] = [];
  const handler = makeAutoCompactHandler({
    getRole: (sf) => reportState.activeRole.get(sf ?? ""),
    contextWindow: 100_000,
    thresholdPct: 0.70, // threshold = 70k tokens
  });
  const fire = (sessionFile: string | undefined, tokens: number | null, parentSession?: string) =>
    handler(
      { type: "turn_end" },
      {
        // The child's sessionManager carries the parentSession header (spawnRole
        // set it via newSession({parentSession})). This is the gate the fix uses.
        sessionManager: { getSessionFile: () => sessionFile, getHeader: () => (parentSession ? { parentSession } : undefined) },
        compact: (o) => { compactions.push(o.customInstructions ?? ""); o.onComplete?.(); },
        getContextUsage: () => ({ tokens }),
      },
    );
  return { compactions, fire };
}

describe("P1-5 live — fix regression guard (header gating, prod wiring)", () => {
  const CHILD_SF = "/tmp/child-role-session.jsonl";
  const HIGH_TOKENS = 80_000; // well above the 70k threshold

  it("PROD child (empty activeRole + parentSession header) → compaction FIRES (fix)", () => {
    // The child's own pi-roles instance has an empty reportState (nobody populates
    // activeRole for it). With the fix (header gating), compaction now fires.
    const childReportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const h = wire(childReportState);
    h.fire(CHILD_SF, HIGH_TOKENS, "probe-parent"); // empty activeRole BUT header set
    assert.equal(h.compactions.length, 1, "FIX: child with empty activeRole + parentSession header MUST compact (header gating)");
    assert.match(h.compactions[0], /key findings/i, "generic prompt (role name unreachable from child without pi-core change)");
  });

  it("MAIN session (no parentSession header) → NO compaction", () => {
    const rs: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const h = wire(rs);
    h.fire("/tmp/main.jsonl", 95_000); // high tokens, no header
    assert.equal(h.compactions.length, 0, "main session not compacted (only role subagents)");
  });

  it("BELOW threshold → NO compaction (headroom preserved for the next huge tool_result)", () => {
    const rs: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const h = wire(rs);
    h.fire(CHILD_SF, 65_000, "probe-parent"); // below 70k
    assert.equal(h.compactions.length, 0, "below threshold: no compaction (don't compact eagerly)");
  });

  it("role-specific prompt preserved when getRole resolves (parent-side / shared-state case)", () => {
    // If the role name IS reachable (e.g. the parent session, or a future
    // role-header mechanism), the role-specific compaction prompt is used.
    const rs: ReportState = { reported: new Set(), activeRole: new Map([[CHILD_SF, "researcher"]]), payloads: new Map() };
    const h = wire(rs);
    h.fire(CHILD_SF, HIGH_TOKENS, "probe-parent");
    assert.equal(h.compactions.length, 1);
    assert.match(h.compactions[0], /citation/i, "role-specific prompt when role name is reachable");
  });
});

describe("P1-5 live — verdict (post-fix)", () => {
  it("documents the fix: P1-5 compaction now works for child role sessions", () => {
    console.log("\n[P1-5 VERDICT post-fix] The auto-compact handler is registered + dispatched on");
    console.log("  child sessions (proven live by probe-p0-4-contract-live.ts via the same");
    console.log("  child-side pi.on mechanism). The gating bug (isRoleSession reading the");
    console.log("  child's empty reportState.activeRole → no-op) is FIXED: isRoleSession now");
    console.log("  gates on the session header's parentSession (set by spawnRole for every");
    console.log("  child). Compaction now fires for child role sessions before the overflow");
    console.log("  cliff, with the generic prompt (role-specific prompts remain unreachable");
    console.log("  from the child without a pi-core session-header change — documented, not");
    console.log("  a regression: they were never reachable in prod).\n");
    assert.ok(true);
  });
});
