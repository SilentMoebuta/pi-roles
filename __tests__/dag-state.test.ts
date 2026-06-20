import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateWaves, errorContextPrefix } from "../src/dag/state";
import type { WaveResult } from "../src/dag/types";

describe("dag state (aggregation + error propagation)", () => {
  it("status='completed' when no failures", () => {
    const waves: WaveResult[] = [
      { wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: ["fa"], artifacts: [] } }], failures: [] },
    ];
    const r = aggregateWaves(waves);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.finalContext.a, { findings: ["fa"], artifacts: [] });
  });

  it("status='partial' when some nodes fail but some succeed", () => {
    const waves: WaveResult[] = [
      { wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: [], artifacts: [] } }], failures: [{ nodeId: "b", status: "failed", error: "boom" }] },
    ];
    const r = aggregateWaves(waves);
    assert.equal(r.status, "partial");
    assert.ok(r.finalContext.a, "successful node still in finalContext");
  });

  it("status='failed' when ALL nodes fail", () => {
    const waves: WaveResult[] = [
      { wave: 0, successes: [], failures: [{ nodeId: "a", status: "failed", error: "x" }] },
    ];
    assert.equal(aggregateWaves(waves).status, "failed");
  });

  it("errorContextPrefix describes the failed predecessor for downstream nodes", () => {
    const prefix = errorContextPrefix("a", "boom");
    assert.match(prefix, /Predecessor 'a' failed/);
    assert.match(prefix, /boom/);
    assert.match(prefix, /retry, skip, fallback/);
  });
});
