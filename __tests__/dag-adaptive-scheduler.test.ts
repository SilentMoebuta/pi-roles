import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import { makeCheckpoint, makeCheckpointV2, serializeCheckpoint, deserializeCheckpoint, resumeDAG } from "../src/dag/checkpoint";
import { normalizeWriteScope, scopesOverlap } from "../src/dag/scope";
import { validateDAG } from "../src/dag/validate";
import type { DAGExecutionSnapshot, DAGSpec } from "../src/dag/types";

const completed = (id: string) => ({
  agentId: id,
  wait: async () => ({ status: "completed" as const, reportPayload: { findings: [id], artifacts: [] } }),
});

function nodeId(task: string): string {
  return (task.match(/\[node:([^\]]+)\]/) ?? ["", task])[1];
}

describe("adaptive DAG scheduler", () => {
  it("does not consume maxDepth per wave and completes chains longer than five", async () => {
    const nodes: DAGSpec["nodes"] = {};
    for (let i = 0; i < 7; i++) {
      nodes[`n${i}`] = { task: `[node:n${i}] work`, depends_on: i === 0 ? undefined : [`n${i - 1}`] };
    }
    const result = await executeDAGCore({ nodes, maxDepth: 1 }, async (_role, task) => completed(nodeId(task)));
    assert.equal(result.status, "completed");
    assert.equal(result.termination, "all_terminal");
    assert.equal(result.metrics?.completed, 7);
    assert.equal(result.waves.length, 7);
  });

  it("defaults to ready mode and unlocks a fast branch before an unrelated slow root settles", async () => {
    let releaseSlow!: () => void;
    let slowDone = false;
    let childStartedBeforeSlow = false;
    const spec: DAGSpec = { nodes: {
      slow: { task: "[node:slow] slow" },
      fast: { task: "[node:fast] fast" },
      child: { task: "[node:child] child", depends_on: ["fast"] },
    }};
    const spawnFn: SpawnFn = async (_role, task) => {
      const id = nodeId(task);
      if (id === "slow") {
        return { agentId: id, wait: () => new Promise((resolve) => {
          releaseSlow = () => { slowDone = true; resolve({ status: "completed", reportPayload: { findings: [id], artifacts: [] } }); };
        }) };
      }
      if (id === "child") {
        childStartedBeforeSlow = !slowDone;
        releaseSlow();
      }
      return completed(id);
    };
    const schedulers: string[] = [];
    const result = await executeDAGCore(spec, spawnFn, {
      maxConcurrent: 2,
      onProgress: (event) => { if (event.scheduler) schedulers.push(event.scheduler); },
    });
    assert.equal(result.status, "completed");
    assert.equal(childStartedBeforeSlow, true);
    assert.deepEqual(new Set(schedulers), new Set(["ready"]));
  });

  it("keeps the explicit wave scheduler as a barrier fallback", async () => {
    let releaseSlow!: () => void;
    const spawned: string[] = [];
    const spec: DAGSpec = { nodes: {
      slow: { task: "[node:slow] slow" },
      fast: { task: "[node:fast] fast" },
      child: { task: "[node:child] child", depends_on: ["fast"] },
    }};
    const execution = executeDAGCore(spec, async (_role, task) => {
      const id = nodeId(task);
      spawned.push(id);
      if (id !== "slow") return completed(id);
      return {
        agentId: id,
        wait: () => new Promise((resolve) => {
          releaseSlow = () => resolve({ status: "completed", reportPayload: { findings: [id], artifacts: [] } });
        }),
      };
    }, { scheduler: "wave", maxConcurrent: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawned.includes("child"), false);
    releaseSlow();
    const result = await execution;
    assert.equal(result.status, "completed");
    assert.deepEqual(spawned, ["slow", "fast", "child"]);
  });

  it("ready ordering is priority, then remaining critical path, then declaration order", async () => {
    const order: string[] = [];
    const spec: DAGSpec = { nodes: {
      critical: { task: "[node:critical] root" },
      high: { task: "[node:high] root", priority: 10 },
      ordinary: { task: "[node:ordinary] root" },
      criticalChild: { task: "[node:criticalChild] child", depends_on: ["critical"] },
    }};
    await executeDAGCore(spec, async (_role, task) => {
      order.push(nodeId(task));
      return completed(nodeId(task));
    }, { scheduler: "ready", maxConcurrent: 1 });
    assert.deepEqual(order.slice(0, 2), ["high", "critical"]);
  });

  it("maxConcurrent covers the full node runtime, not only session creation", async () => {
    let active = 0;
    let peak = 0;
    const spec: DAGSpec = { nodes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}`, { task: `[node:n${i}] work` }])) };
    const result = await executeDAGCore(spec, async (_role, task) => ({
      agentId: nodeId(task),
      wait: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: "completed" as const, reportPayload: { findings: [], artifacts: [] } };
      },
    }), { scheduler: "ready", maxConcurrent: 2 });
    assert.equal(result.status, "completed");
    assert.equal(peak, 2);
    assert.equal(result.metrics?.peakConcurrent, 2);
  });

  it("serializes overlapping write scopes while allowing a disjoint scope to run", async () => {
    const activeScopes = new Map<string, string[]>();
    let overlapObserved = false;
    let disjointParallel = false;
    const spec: DAGSpec = { nodes: {
      a: { task: "[node:a] work", write_scope: ["src"] },
      b: { task: "[node:b] work", write_scope: ["./src/core"] },
      c: { task: "[node:c] work", write_scope: ["docs"] },
    }};
    const result = await executeDAGCore(spec, async (_role, task) => {
      const id = nodeId(task);
      const scopes = (spec.nodes[id].write_scope ?? []).map(normalizeWriteScope);
      return {
        agentId: id,
        wait: async () => {
          for (const held of activeScopes.values()) {
            if (scopes.some((a) => held.some((b) => scopesOverlap(a, b)))) overlapObserved = true;
            else disjointParallel = true;
          }
          activeScopes.set(id, scopes);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeScopes.delete(id);
          return { status: "completed" as const, reportPayload: { findings: [id], artifacts: [] } };
        },
      };
    }, { scheduler: "ready", maxConcurrent: 3 });
    assert.equal(result.status, "completed");
    assert.equal(overlapObserved, false);
    assert.equal(disjointParallel, true);
  });

  it("releases a write-scope lease after timeout so the next node can run", async () => {
    let secondStarted = false;
    const spec: DAGSpec = { nodes: {
      timeout: { task: "[node:timeout] hangs", write_scope: ["src"], timeout_ms: 5, priority: 10 },
      after: { task: "[node:after] runs", write_scope: ["src"] },
    }};
    const result = await executeDAGCore(spec, async (_role, task) => {
      const id = nodeId(task);
      if (id === "timeout") return { agentId: id, wait: async () => new Promise(() => {}) };
      secondStarted = true;
      return completed(id);
    }, { scheduler: "ready", maxConcurrent: 2 });
    assert.equal(secondStarted, true);
    assert.equal(result.nodeStates?.timeout.status, "failed");
    assert.equal(result.nodeStates?.after.status, "completed");
    assert.equal(result.status, "partial");
  });

  it("never reports completed when abort leaves declared nodes unexecuted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeDAGCore({ nodes: { a: { task: "a" } } }, async () => completed("a"), { signal: controller.signal });
    assert.equal(result.status, "failed");
    assert.equal(result.termination, "aborted");
    assert.equal(result.nodeStates?.a.status, "queued");
    assert.equal(result.metrics?.queued, 1);
  });

  it("emits complete explicit progress snapshots", async () => {
    const progress: any[] = [];
    await executeDAGCore({ nodes: { a: { task: "a" }, b: { task: "b", depends_on: ["a"] } } }, async (_r, task) => completed(task), {
      scheduler: "ready",
      onProgress: (event) => progress.push(event),
    });
    assert.ok(progress.length >= 3);
    assert.ok(progress.every((event) => event.explicitStates === true));
    assert.ok(progress.every((event) => Object.keys(event.nodes).sort().join(",") === "a,b"));
  });

  it("reports deterministic per-node, wall, serial, critical-path, and concurrency metrics", async () => {
    let clock = 1_000;
    const durations: Record<string, number> = { a: 10, b: 5, c: 7 };
    const spec: DAGSpec = { nodes: {
      a: { task: "[node:a] root" },
      b: { task: "[node:b] independent" },
      c: { task: "[node:c] consumes a", depends_on: ["a"] },
    }};
    const result = await executeDAGCore(spec, async (_role, task) => {
      const id = nodeId(task);
      return {
        agentId: id,
        wait: async () => {
          clock += durations[id];
          return { status: "completed" as const, reportPayload: { findings: [id], artifacts: [] } };
        },
      };
    }, { maxConcurrent: 1, now: () => clock });

    assert.deepEqual(result.metrics?.nodeTimings, {
      a: { queueTimeMs: 0, runTimeMs: 10 },
      b: { queueTimeMs: 10, runTimeMs: 5 },
      c: { queueTimeMs: 5, runTimeMs: 7 },
    });
    assert.equal(result.metrics?.wallTimeMs, 22);
    assert.equal(result.metrics?.durationMs, 22);
    assert.equal(result.metrics?.serialTimeMs, 22);
    assert.equal(result.metrics?.criticalPathMs, 17);
    assert.equal(result.metrics?.maxConcurrent, 1);
    assert.equal(result.metrics?.peakConcurrent, 1);
    assert.equal(result.metrics?.downstreamResultConsumptionCount, 1);
  });

  it("counts routing decisions and fan-out child dispatches", async () => {
    let clock = 0;
    const spec: DAGSpec = { nodes: {
      router: { task: "[node:router] choose", routes: { go: ["fan"] } },
      fan: {
        task: "[node:fan] fan out",
        depends_on: ["router"],
        sends: [{ role: "worker", arg: "one" }, { role: "worker", arg: "two" }],
      },
    }};
    const result = await executeDAGCore(spec, async (_role, task) => ({
      agentId: task,
      wait: async () => {
        clock += 3;
        return {
          status: "completed" as const,
          reportPayload: task.includes("[node:router]")
            ? { findings: [], artifacts: [], route: "go" }
            : { findings: [task], artifacts: [] },
        };
      },
    }), { maxConcurrent: 1, now: () => clock });

    assert.equal(result.status, "completed");
    assert.equal(result.metrics?.routeCount, 1);
    assert.equal(result.metrics?.dispatchCount, 2);
    assert.equal(result.metrics?.downstreamResultConsumptionCount, 1);
  });

  it("keeps legacy inline fan-out above the V2 default bound compatible", async () => {
    const spec: DAGSpec = { nodes: {
      legacy: {
        task: "legacy fan-out",
        sends: Array.from({ length: 9 }, (_, index) => ({ role: "worker", arg: `legacy-${index}` })),
      },
    } };
    assert.equal(validateDAG(spec).ok, true);
    const result = await executeDAGCore(spec, async (_role, task) => completed(task));
    assert.equal(result.status, "completed");
    assert.equal(result.finalContext.legacy.findings.length, 9);
  });
});

describe("V2 checkpoints and preflight bounds", () => {
  it("resumes terminal nodes without replay and requeues a previously running node", async () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "[node:a] done" },
      b: { task: "[node:b] retry" },
      c: { task: "[node:c] downstream", depends_on: ["b"] },
    }};
    const snapshot: DAGExecutionSnapshot = {
      scheduler: "ready",
      expandedSpec: spec,
      nodeStates: { a: { status: "completed" }, b: { status: "running" }, c: { status: "queued" } },
      nodeResults: { a: { nodeId: "a", status: "completed", result: { findings: ["a"], artifacts: [] } } },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, snapshot)));
    const spawned: string[] = [];
    const result = await resumeDAG(checkpoint, async (_role, task) => {
      spawned.push(nodeId(task));
      return completed(nodeId(task));
    }, { maxConcurrent: 1 });
    assert.deepEqual(spawned, ["b", "c"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalContext.a.findings, ["a"]);
  });

  it("uses a V2 checkpoint scheduler unless overridden and defaults V1 resume to ready", async () => {
    const spec: DAGSpec = { nodes: { a: { task: "[node:a] work" } } };
    const snapshot: DAGExecutionSnapshot = {
      scheduler: "wave",
      expandedSpec: spec,
      nodeStates: { a: { status: "queued" } },
      nodeResults: {},
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    const v2Schedulers: string[] = [];
    await resumeDAG(makeCheckpointV2(spec, snapshot), async () => completed("a"), {
      onProgress: (event) => { if (event.scheduler) v2Schedulers.push(event.scheduler); },
    });
    assert.deepEqual(new Set(v2Schedulers), new Set(["wave"]));

    const v1Schedulers: string[] = [];
    await resumeDAG(makeCheckpoint(spec, []), async () => completed("a"), {
      onProgress: (event) => { if (event.scheduler) v1Schedulers.push(event.scheduler); },
    });
    assert.deepEqual(new Set(v1Schedulers), new Set(["ready"]));
  });

  it("rejects unknown explicit roles, invalid scopes, excessive fan-out, and dispatch depth >2", () => {
    const roles = new Map<string, unknown>([["coder", {}]]);
    assert.match(validateDAG({ nodes: { a: { role: "missing", task: "x" } } }, roles).errors.join("\n"), /unknown role/);
    assert.match(validateDAG({ nodes: { a: { task: "x", write_scope: ["../outside"] } } }).errors.join("\n"), /escapes/);
    assert.equal(validateDAG({ nodes: { a: { task: "x", write_scope: ["src/**"] } } }).ok, true);
    assert.match(validateDAG({ nodes: { a: {
      task: "x",
      dispatch: {},
      sends: Array.from({ length: 9 }, (_, index) => ({
        key: `send-${index}`,
        role: "coder",
        arg: "x",
        expected_output: `result-${index}`,
        consumers: ["$parent"],
      })),
    } } }, roles).errors.join("\n"), /exceeding maxChildren=8/);
    const threeDispatches: DAGSpec = { nodes: {
      a: { task: "a", dispatch: {}, sends: [{ key: "a", role: "coder", arg: "a", expected_output: "a", consumers: ["$parent"] }] },
      b: { task: "b", depends_on: ["a"], dispatch: {}, sends: [{ key: "b", role: "coder", arg: "b", expected_output: "b", consumers: ["$parent"] }] },
      c: { task: "c", depends_on: ["b"], dispatch: {}, sends: [{ key: "c", role: "coder", arg: "c", expected_output: "c", consumers: ["$parent"] }] },
    }};
    assert.match(validateDAG(threeDispatches, roles).errors.join("\n"), /dispatch depth 3/);
  });

  it("treats the normalized repository root as overlapping every narrower scope", () => {
    assert.equal(normalizeWriteScope("./"), ".");
    assert.equal(scopesOverlap(".", "src/core"), true);
  });
});
