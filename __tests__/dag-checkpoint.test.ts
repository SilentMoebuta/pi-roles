import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeCheckpoint, deserializeCheckpoint, makeCheckpoint, resumeDAG } from "../src/dag/checkpoint";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec, WaveResult } from "../src/dag/types";

function fakeSpawn(outcomes: Record<string, { status: "completed" | "failed"; result?: { findings: string[]; artifacts: [] }; error?: string }>): SpawnFn {
  return async (_role, task) => {
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    const oc = outcomes[nodeId] ?? { status: "completed" as const, result: { findings: [task], artifacts: [] } };
    return {
      agentId: nodeId,
      wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }),
    };
  };
}

describe("dag checkpoint (5e) — serialize/deserialize + resume", () => {
  it("serialize → deserialize round-trips a checkpoint", () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "t" } } };
    const waves: WaveResult[] = [{ wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: ["f"], artifacts: [] } }], failures: [] }];
    const cp = makeCheckpoint(spec, waves);
    const json = serializeCheckpoint(cp);
    const back = deserializeCheckpoint(json);
    assert.deepEqual(back, cp);
  });

  it("deserialize throws on malformed input", () => {
    assert.throws(() => deserializeCheckpoint("not json"), /JSON/);
    assert.throws(() => deserializeCheckpoint("{}"), /malformed/);
  });

  it("resume skips already-completed waves and continues with prior results preserved", async () => {
    // 3-wave DAG: a → b → c. Checkpoint after wave 0 (a done). Resume should
    // run waves 1,2 (b, c) and NOT re-run a.
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b", depends_on: ["a"] },
      c: { role: "coder", task: "[node:c] do c", depends_on: ["b"] },
    }};
    // First run wave 0 only (simulate crash after wave 0).
    const completedWave0: WaveResult = {
      wave: 0,
      successes: [{ nodeId: "a", status: "completed", result: { findings: ["a-done"], artifacts: [] } }],
      failures: [],
    };
    const cp = makeCheckpoint(spec, [completedWave0]);

    // Resume: b and c should run; a should NOT be re-spawned.
    let spawnedNodes: string[] = [];
    const spawnFn: SpawnFn = async (role, task) => {
      const m = task.match(/\[node:([^\]]+)\]/);
      const nodeId = m![1];
      spawnedNodes.push(nodeId);
      return { agentId: nodeId, wait: async () => ({ status: "completed", result: { findings: [`${nodeId}-done`], artifacts: [] }, reportPayload: { findings: [`${nodeId}-done`], artifacts: [] } }) };
    };
    const r = await resumeDAG(cp, spawnFn);
    // a was NOT re-run; only b and c.
    assert.deepEqual(spawnedNodes.sort(), ["b", "c"], "resumed waves only — a skipped");
    assert.equal(r.status, "completed");
    // prior result preserved
    assert.deepEqual(r.finalContext.a, { findings: ["a-done"], artifacts: [] });
    // new results present
    assert.ok(r.finalContext.b);
    assert.ok(r.finalContext.c);
  });

  it("resume with a completed checkpoint (all waves done) returns the same result, no spawns", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] x" } } };
    const full: WaveResult[] = [{ wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: ["done"], artifacts: [] } }], failures: [] }];
    const cp = makeCheckpoint(spec, full);
    let spawnCount = 0;
    const spawnFn: SpawnFn = async () => { spawnCount++; return { agentId: "x", wait: async () => ({ status: "completed" }) }; };
    const r = await resumeDAG(cp, spawnFn);
    assert.equal(spawnCount, 0, "nothing spawned — all waves already done");
    assert.equal(r.status, "completed");
    assert.deepEqual(r.finalContext.a, { findings: ["done"], artifacts: [] });
  });
});
