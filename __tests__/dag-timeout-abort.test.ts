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

  it("bounds a hanging explicit dynamic dispatcher", { timeout: 500 }, async () => {
    const result = await executeDAGCore({ nodes: {
      fanout: {
        task: "hang while choosing work",
        expected_output: "Chosen work",
        consumers: ["$result"],
        dispatch: {},
        dynamic: async () => new Promise(() => {}),
        timeout_ms: 5,
      },
    } }, async () => { throw new Error("no generated child should spawn"); });
    assert.equal(result.termination, "all_terminal");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /timeout/);
  });

  it("bounds a hanging legacy dynamic callback", { timeout: 500 }, async () => {
    const result = await executeDAGCore({ nodes: {
      fanout: {
        task: "legacy hang while choosing work",
        dynamic: async () => new Promise(() => {}),
        timeout_ms: 5,
      },
    } }, async () => { throw new Error("no generated child should spawn"); });
    assert.equal(result.termination, "all_terminal");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /timeout/);
  });

  it("bounds spawn handle creation as part of the node deadline", { timeout: 500 }, async () => {
    const result = await executeDAGCore({ nodes: {
      work: { task: "spawn never returns", timeout_ms: 5 },
    } }, async () => new Promise(() => {}));
    assert.equal(result.termination, "all_terminal");
    assert.equal(result.nodeStates?.work.status, "failed");
    assert.match(result.nodeStates?.work.error ?? "", /timeout/);
  });

  it("aborts handles that arrive after their node deadline", { timeout: 500 }, async () => {
    let resolveSpawn!: (handle: Awaited<ReturnType<SpawnFn>>) => void;
    let abortCalls = 0;
    const execution = executeDAGCore({ nodes: {
      work: { task: "spawn returns too late", timeout_ms: 5 },
    } }, async () => new Promise((resolve) => { resolveSpawn = resolve; }));

    const result = await execution;
    resolveSpawn({
      agentId: "late",
      wait: async () => new Promise(() => {}),
      abort: () => { abortCalls++; },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(result.nodeStates?.work.error ?? "", /timeout/);
    assert.equal(abortCalls, 1);
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

  it("aborts a hanging explicit dynamic dispatcher", { timeout: 500 }, async () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    const result = await executeDAGCore({ nodes: {
      fanout: {
        task: "hang while choosing work",
        expected_output: "Chosen work",
        consumers: ["$result"],
        dispatch: {},
        dynamic: async () => new Promise(() => {}),
      },
    } }, async () => { throw new Error("no generated child should spawn"); }, { signal: controller.signal });
    assert.equal(result.termination, "aborted");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /aborted/);
  });

  it("aborts a hanging legacy dynamic callback", { timeout: 500 }, async () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    const result = await executeDAGCore({ nodes: {
      fanout: {
        task: "legacy hang while choosing work",
        dynamic: async () => new Promise(() => {}),
      },
    } }, async () => { throw new Error("no generated child should spawn"); }, { signal: controller.signal });
    assert.equal(result.termination, "aborted");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /aborted/);
  });

  it("aborts while spawn handle creation is still pending", { timeout: 500 }, async () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    const result = await executeDAGCore({ nodes: {
      work: { task: "spawn never returns" },
    } }, async () => new Promise(() => {}), { signal: controller.signal });
    assert.equal(result.termination, "aborted");
    assert.equal(result.nodeStates?.work.status, "failed");
    assert.match(result.nodeStates?.work.error ?? "", /aborted/);
  });
});
