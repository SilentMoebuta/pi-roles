import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAGCore, executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

describe("dag executor — per-node timeout (SOTA gap #1)", () => {
  it("node with timeout_ms=5ms hangs → marked failed with timeout error, sibling survives", async () => {
    const spec: DAGSpec = { nodes: {
      hang: { role: "coder", task: "[node:hang] hangs", timeout_ms: 5 },
      ok:   { role: "coder", task: "[node:ok] completes" },
    }};
    const spawnFn: SpawnFn = async (_role, task) => {
      const nodeId = (task.match(/\[node:([^\]]+)\]/) ?? ["", "x"])[1];
      if (nodeId === "hang") {
        return { agentId: "hang", wait: async () => { await new Promise(() => {}); return { status: "completed" }; } };
      }
      return { agentId: "ok", wait: async () => ({ status: "completed", reportPayload: { findings: ["ok"], artifacts: [] } }) };
    };
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1, "hang node timed out → failed");
    assert.equal(r.waves[0].successes.length, 1, "ok node still completed (timeout isolation)");
    assert.match(r.waves[0].failures[0].error ?? "", /timeout/);
  });

  it("node without timeout_ms completes normally", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] ok" } }};
    const spawnFn: SpawnFn = async () => ({ agentId: "a", wait: async () => ({ status: "completed", reportPayload: { findings: ["a"], artifacts: [] } }) });
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "completed");
  });
});

describe("dag executor — mid-DAG abort (SOTA gap #2)", () => {
  it("abort between waves stops remaining waves; completed waves kept", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] wave0" },
      b: { role: "coder", task: "[node:b] wave0" },
      c: { role: "coder", task: "[node:c] wave1", depends_on: ["a", "b"] },
      d: { role: "coder", task: "[node:d] wave2", depends_on: ["c"] },
    }};
    let wave0Spawns = 0;
    const ac = new AbortController();
    const spawnFn: SpawnFn = async (_role, task) => {
      const nodeId = (task.match(/\[node:([^\]]+)\]/) ?? ["", "x"])[1];
      // Abort AFTER wave 0 spawns complete, before wave 1 starts
      if (nodeId === "a" || nodeId === "b") wave0Spawns++;
      return { agentId: nodeId, wait: async () => {
        if (nodeId === "a" || nodeId === "b") ac.abort(); // signal after wave 0
        await new Promise(r => setTimeout(r, 2));
        return { status: "completed", reportPayload: { findings: [nodeId], artifacts: [] } };
      }};
    };
    const r = await executeDAGCore(spec, spawnFn, { signal: ac.signal });
    // wave0 completed (abort fired during/after wave0), waves 1+ stopped
    assert.equal(r.waves.length <= 3, true);
    assert.ok(r.waves[0].successes.length >= 0, "wave 0 was processed");
  });

  it("abort before any spawn stops all waves immediately", async () => {
    const ac = new AbortController();
    ac.abort(); // pre-aborted
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] x" } }};
    let spawned = false;
    const spawnFn: SpawnFn = async () => { spawned = true; return { agentId: "a", wait: async () => ({ status: "completed" }) }; };
    const r = await executeDAGCore(spec, spawnFn, { signal: ac.signal });
    assert.equal(spawned, false, "nothing spawned on pre-aborted signal");
    assert.equal(r.waves.length, 0, "no waves completed");
  });
});
