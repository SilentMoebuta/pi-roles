import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, executeDAGCore, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

// Fake spawnFn: completes after a tick. Configurable per-node outcome.
function fakeSpawn(outcomes: Record<string, { status: "completed" | "failed"; result?: { findings: string[]; artifacts: string[] }; error?: string }>): SpawnFn {
  return async (role: string | undefined, task: string) => {
    // derive nodeId from task marker "[node:<id>]" injected by test specs
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    const oc = outcomes[nodeId] ?? { status: "completed" as const, result: { findings: [task], artifacts: [] } };
    return {
      agentId: nodeId,
      wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }),
    };
  };
}

describe("dag executor (waves + barrier + partial failure)", () => {
  it("runs a 2-wave DAG to completion", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
      c: { role: "reviewer", task: "[node:c] review", depends_on: ["a", "b"] },
    }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "completed", result: { findings: ["fa"], artifacts: [] } }, b: { status: "completed", result: { findings: ["fb"], artifacts: [] } }, c: { status: "completed", result: { findings: ["fc"], artifacts: [] } } }));
    assert.equal(r.status, "completed");
    assert.equal(r.waves.length, 2);
    assert.equal(r.waves[0].successes.length, 2);
    assert.equal(r.waves[1].successes.length, 1);
  });

  it("partial failure: a failed node does NOT abort its sibling in the same wave", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
    }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "failed", error: "boom" }, b: { status: "completed", result: { findings: ["fb"], artifacts: [] } } }));
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1);
    assert.equal(r.waves[0].successes.length, 1, "sibling b still succeeded despite a failing");
  });

  it("downstream node receives error context when a predecessor failed", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b", depends_on: ["a"] },
    }};
    let seenTask = "";
    const spawnFn: SpawnFn = async (_role, task) => {
      if (task.includes("[node:b]")) seenTask = task;
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      const oc = nodeId === "a" ? { status: "failed" as const, error: "boom" } : { status: "completed" as const, result: { findings: [], artifacts: [] } };
      return { agentId: nodeId, wait: async () => ({ status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result }) };
    };
    await executeDAG(spec, spawnFn);
    assert.match(seenTask, /Predecessor 'a' failed/);
  });

  it("status='failed' when the only node fails", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] do a" } }};
    const r = await executeDAG(spec, fakeSpawn({ a: { status: "failed", error: "x" } }));
    assert.equal(r.status, "failed");
  });

  it("upstream results injected into downstream static node task (Gap D fix)", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] write auth" },
      b: { role: "reviewer", task: "[node:b] review", depends_on: ["a"] },
    }};
    let bTask = "";
    const spawnFn: SpawnFn = async (_role, task) => {
      if (task.includes("[node:b]")) bTask = task;
      const nodeId = (task.match(/\[node:([^\]]+)\]/) ?? ["", "x"])[1];
      const oc = nodeId === "a" ? { status: "completed" as const, result: { findings: ["auth-done"], artifacts: ["src/auth.ts", "src/session.ts"] } }
        : { status: "completed" as const, result: { findings: ["review-done"], artifacts: [] } };
      return { agentId: nodeId, wait: async () => ({ status: oc.status, result: oc.result, reportPayload: oc.result }) };
    };
    await executeDAG(spec, spawnFn);
    // b's task should contain upstream results JSON with actual artifact paths
    assert.ok(bTask.includes('src/auth.ts'), "b sees auth's actual artifact: src/auth.ts");
    assert.ok(bTask.includes('src/session.ts'), "b sees auth's actual artifact: src/session.ts");
    assert.ok(bTask.includes('[Upstream results'), "task has the Upstream results prefix");
  });

  it("spawn-phase rejection does NOT abort sibling spawns (allSettled on spawn too)", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
    }};
    // spawnFn rejects for node 'a' (e.g. bad role/config), succeeds for 'b'.
    const spawnFn: SpawnFn = async (_role, task) => {
      if (task.includes("[node:a]")) throw new Error("spawn rejected: bad role config");
      return { agentId: "b", wait: async () => ({ status: "completed" as const, result: { findings: ["b ok"], artifacts: [] }, reportPayload: { findings: ["b ok"], artifacts: [] } }) };
    };
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1, "node a's rejected spawn → failed");
    assert.match(r.waves[0].failures[0].error ?? "", /spawn rejected/);
    assert.equal(r.waves[0].successes.length, 1, "sibling b still spawned + completed (spawn-phase isolation)");
  });
  it("emits selected route metadata in settled progress", async () => {
    const spec: DAGSpec = { nodes: {
      decide: { role: "reviewer", task: "[node:decide] choose", routes: { accept: ["accept"], revise: ["revise"] } },
      accept: { role: "coder", task: "[node:accept] accept", depends_on: ["decide"] },
      revise: { role: "coder", task: "[node:revise] revise", depends_on: ["decide"] },
    }};
    const progress: any[] = [];
    await executeDAGCore(spec, async (_role, task) => {
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      const result = nodeId === "decide"
        ? { findings: ["choose accept"], artifacts: [], route: "accept" }
        : { findings: [`${nodeId} ran`], artifacts: [] };
      return { agentId: nodeId, wait: async () => ({ status: "completed" as const, result, reportPayload: result }) };
    }, { onProgress: (p) => progress.push(p) });

    const settled = progress.find((p) => p.nodes.decide?.route === "accept");
    assert.equal(settled?.nodes.decide.route, "accept");
  });

  it("routes to the selected branch and skips unselected branch nodes", async () => {
    const spec: DAGSpec = { nodes: {
      decide: { role: "reviewer", task: "[node:decide] choose", routes: { accept: ["accept"], revise: ["revise"] } },
      accept: { role: "coder", task: "[node:accept] accept", depends_on: ["decide"] },
      revise: { role: "coder", task: "[node:revise] revise", depends_on: ["decide"] },
    }};
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (_role, task) => {
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      spawned.push(nodeId);
      const result = nodeId === "decide"
        ? { findings: ["choose accept"], artifacts: [], route: "accept" }
        : { findings: [`${nodeId} ran`], artifacts: [] };
      return { agentId: nodeId, wait: async () => ({ status: "completed" as const, result, reportPayload: result }) };
    };

    const r = await executeDAG(spec, spawnFn);

    assert.equal(r.status, "completed");
    assert.deepEqual(spawned, ["decide", "accept"], "unselected revise node was not spawned");
    assert.equal(r.waves[1].successes[0].nodeId, "accept");
    assert.equal(r.waves[1].skipped?.[0].nodeId, "revise");
    assert.equal(r.waves[1].skipped?.[0].status, "skipped");
    assert.ok(!("revise" in r.finalContext), "skipped node absent from finalContext");
  });

  it("unknown route fails the branch node", async () => {
    const spec: DAGSpec = { nodes: {
      decide: { role: "reviewer", task: "[node:decide] choose", routes: { accept: ["accept"] } },
      accept: { role: "coder", task: "[node:accept] accept", depends_on: ["decide"] },
    }};
    const r = await executeDAG(spec, async (_role, task) => {
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      const result = { findings: [], artifacts: [], route: "missing" };
      return { agentId: nodeId, wait: async () => ({ status: "completed" as const, result, reportPayload: result }) };
    });

    assert.equal(r.status, "partial");
    assert.match(r.waves[0].failures[0].error ?? "", /unknown route 'missing'/);
    assert.equal(r.waves[1].skipped?.[0].nodeId, "accept");
  });

  it("missing route fails a routing node", async () => {
    const spec: DAGSpec = { nodes: {
      decide: { role: "reviewer", task: "[node:decide] choose", routes: { accept: ["accept"] } },
      accept: { role: "coder", task: "[node:accept] accept", depends_on: ["decide"] },
    }};
    const r = await executeDAG(spec, async (_role, task) => {
      const nodeId = task.match(/\[node:([^\]]+)\]/)![1];
      const result = { findings: [], artifacts: [] };
      return { agentId: nodeId, wait: async () => ({ status: "completed" as const, result, reportPayload: result }) };
    });

    assert.equal(r.status, "partial");
    assert.match(r.waves[0].failures[0].error ?? "", /missing route/);
    assert.equal(r.waves[1].skipped?.[0].nodeId, "accept");
  });
});
