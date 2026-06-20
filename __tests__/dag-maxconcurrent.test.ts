import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAGCore, executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

// Gap B: maxConcurrent semaphore — a wave of 7 nodes should respect maxConcurrent=3
// (override the default 5 to make the test faster). We track the peak concurrent
// spawns via a running counter asserted inside the spawnFn.

function slowSpawn(outcomes: Record<string, { status: "completed" | "failed"; result?: { findings: string[]; artifacts: [] }; error?: string }>): { spawnFn: SpawnFn; getPeak: () => number; getMaxObserved: () => number } {
  let running = 0;
  let peak = 0;
  let maxObserved = 0;
  const spawnFn: SpawnFn = async (_role, task) => {
    running++;
    peak = Math.max(peak, running);
    // Simulate a tick so multiple spawns can overlap
    await new Promise((r) => setTimeout(r, 5));
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    const oc = outcomes[nodeId] ?? { status: "completed" as const, result: { findings: [task], artifacts: [] } };
    running--;
    maxObserved = Math.max(maxObserved, peak);
    return {
      agentId: nodeId,
      wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }),
    };
  };
  return { spawnFn, getPeak: () => peak, getMaxObserved: () => maxObserved };
}

describe("dag executor — maxConcurrent semaphore (Gap B)", () => {
  it("wave of 7 nodes with maxConcurrent=3 caps concurrent spawns at 3", async () => {
    // 7 nodes in one wave, all deps=[], all complete
    const nodes: Record<string, { role: string; task: string }> = {};
    const outcomes: Record<string, { status: "completed"; result: { findings: string[]; artifacts: [] } }> = {};
    for (let i = 0; i < 7; i++) {
      nodes[`n${i}`] = { role: "coder", task: `[node:n${i}] task-${i}` };
      outcomes[`n${i}`] = { status: "completed", result: { findings: [`f${i}`], artifacts: [] } };
    }
    const spec: DAGSpec = { nodes };
    const { spawnFn, getPeak } = slowSpawn(outcomes);
    const r = await executeDAGCore(spec, spawnFn, { maxConcurrent: 3 });
    assert.equal(r.status, "completed");
    // The semaphore should prevent more than 3 concurrent spawns in the wave
    assert.ok(getPeak() <= 3, `peak concurrent spawns ${getPeak()} must be ≤ 3 (capped by semaphore, default would have been 7)`);
  });

  it("maxConcurrent=1 serializes spawns (peak ≤ 1)", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] a" },
      b: { role: "coder", task: "[node:b] b" },
      c: { role: "coder", task: "[node:c] c" },
    }};
    const { spawnFn, getPeak } = slowSpawn({ a: { status: "completed", result: { findings: ["a"], artifacts: [] } }, b: { status: "completed", result: { findings: ["b"], artifacts: [] } }, c: { status: "completed", result: { findings: ["c"], artifacts: [] } } });
    const r = await executeDAGCore(spec, spawnFn, { maxConcurrent: 1 });
    assert.equal(r.status, "completed");
    assert.ok(getPeak() <= 1, "maxConcurrent=1 serializes (peak ≤ 1)");
  });

  it("default maxConcurrent=5 without override", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] a" },
      b: { role: "coder", task: "[node:b] b" },
      c: { role: "coder", task: "[node:c] c" },
    }};
    const { spawnFn } = slowSpawn({ a: { status: "completed", result: { findings: ["a"], artifacts: [] } }, b: { status: "completed", result: { findings: ["b"], artifacts: [] } }, c: { status: "completed", result: { findings: ["c"], artifacts: [] } } });
    // executeDAG uses default maxConcurrent=5 via executeDAGCore
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "completed");
    // 3 nodes under default 5 — shouldn't throttle
  });
});
