import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAutoCompactHandler } from "../src/subagent/auto-compact-handler";

// P1-5: proactive compaction for role subagents. A child-side turn_end handler
// (gated on the role-session check) reads ctx.getContextUsage().tokens; when it
// crosses a role-configurable threshold, calls compact({customInstructions})
// BEFORE the overflow cliff. Role-specific prompts preserve what matters.

function harness(roleMap: Map<string, string>, opts: { contextWindow?: number; thresholdPct?: number; autoComplete?: boolean } = {}) {
  const compactions: { instructions?: string; onComplete?: () => void; onError?: (e: Error) => void }[] = [];
  let usageTokens: number | null = null;
  const autoComplete = opts.autoComplete ?? true;
  const handler = makeAutoCompactHandler({
    getRole: (sf) => roleMap.get(sf ?? ""),
    contextWindow: opts.contextWindow ?? 100_000,
    thresholdPct: opts.thresholdPct ?? 0.70,
  });
  const fire = (sessionFile: string | undefined) => handler(
    { type: "turn_end" },
    {
      sessionManager: { getSessionFile: () => sessionFile },
      compact: (o) => {
        compactions.push({ instructions: o.customInstructions, onComplete: o.onComplete, onError: o.onError });
        if (autoComplete) o.onComplete?.();
      },
      getContextUsage: () => ({ tokens: usageTokens }),
    },
  );
  return { handler, compactions, setTokens: (n: number | null) => { usageTokens = n; }, fire };
}

describe("makeAutoCompactHandler — P1-5 proactive compaction", () => {
  it("compacts when tokens cross the threshold (70% of 100k = 70k)", () => {
    const h = harness(new Map([["/tmp/r.jsonl", "researcher"]]));
    h.setTokens(65_000); h.fire("/tmp/r.jsonl"); // below — no compact
    assert.equal(h.compactions.length, 0, "below threshold: no compaction");
    h.setTokens(75_000); h.fire("/tmp/r.jsonl"); // above — compact
    assert.equal(h.compactions.length, 1, "above threshold: compaction triggered");
    assert.match(h.compactions[0].instructions ?? "", /citation/i, "researcher-specific prompt preserves citations");
  });

  it("does NOT compact the MAIN session (no role bound to the sessionFile)", () => {
    const h = harness(new Map()); // empty role map — main session
    h.setTokens(95_000); // way above threshold
    h.fire("/tmp/main.jsonl");
    assert.equal(h.compactions.length, 0, "main session not compacted (only role subagents)");
  });

  it("role-specific prompts: reviewer preserves findings+diff, debugger preserves repro+root-cause", () => {
    const h = harness(new Map([["/tmp/rv.jsonl", "reviewer"], ["/tmp/db.jsonl", "debugger"]]));
    h.setTokens(80_000);
    h.fire("/tmp/rv.jsonl");
    assert.match(h.compactions[0].instructions ?? "", /findings/i);
    assert.match(h.compactions[0].instructions ?? "", /diff/i);
    h.setTokens(80_000);
    h.fire("/tmp/db.jsonl");
    assert.match(h.compactions[1].instructions ?? "", /repro/i);
    assert.match(h.compactions[1].instructions ?? "", /root-cause/i);
  });

  it("does not stack compactions while one is in flight (guard)", () => {
    const h = harness(new Map([["/tmp/r.jsonl", "researcher"]]), { autoComplete: false });
    h.setTokens(80_000);
    h.fire("/tmp/r.jsonl");
    h.fire("/tmp/r.jsonl"); // second turn_end before onComplete fires
    assert.equal(h.compactions.length, 1, "guard prevents stacking while compaction in flight");
  });

  it("graceful degradation: onError clears the guard so a later turn retries", () => {
    let onError: ((e: Error) => void) | undefined;
    const compactions: any[] = [];
    const handler = makeAutoCompactHandler({
      getRole: () => "researcher",
      contextWindow: 100_000,
      thresholdPct: 0.5,
    });
    const fire = () => handler(
      { type: "turn_end" },
      {
        sessionManager: { getSessionFile: () => "/tmp/r.jsonl" },
        compact: (o) => { compactions.push(o); onError = o.onError; },
        getContextUsage: () => ({ tokens: 80_000 }),
      },
    );
    fire();
    onError!(new Error("compact failed")); // compaction failed
    fire(); // guard cleared → retries
    assert.equal(compactions.length, 2, "onError cleared the guard, retry fires");
  });
});
