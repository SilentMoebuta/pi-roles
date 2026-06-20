import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

// spawnFn shaped like the real SubagentsService surface: spawn returns an id
// immediately; wait() polls a shared registry that settles async. This mirrors
// src/subagent/service.ts spawn()/waitForResult() without needing a live pi runtime.
function serviceShapedSpawn(runTable: Record<string, { status: "completed" | "failed"; result?: { findings: string[]; artifacts: string[] }; error?: string }>): SpawnFn {
  const calls: { role: string; task: string }[] = [];
  return async (role, task) => {
    calls.push({ role, task });
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    return {
      agentId: nodeId,
      wait: async () => {
        // one async tick, like a real run settling
        await new Promise((r) => setTimeout(r, 0));
        const oc = runTable[nodeId] ?? { status: "completed" as const, result: { findings: [task], artifacts: [] } };
        return { status: oc.status, result: oc.result, error: oc.error, reportPayload: oc.result };
      },
    };
  };
}

describe("dag smoke — multi-wave end-to-end", () => {
  it("3-wave DAG: 2 coders → reviewer → fixer, all complete", async () => {
    const spec: DAGSpec = { nodes: {
      auth: { role: "coder", task: "[node:auth] write auth middleware" },
      login: { role: "coder", task: "[node:login] write login route" },
      review: { role: "reviewer", task: "[node:review] review auth+login", depends_on: ["auth", "login"] },
      fix: { role: "coder", task: "[node:fix] fix review issues", depends_on: ["review"] },
    }};
    const r = await executeDAG(spec, serviceShapedSpawn({
      auth: { status: "completed", result: { findings: ["auth done"], artifacts: ["/auth.ts"] } },
      login: { status: "completed", result: { findings: ["login done"], artifacts: ["/login.ts"] } },
      review: { status: "completed", result: { findings: ["looks good"], artifacts: [] } },
      fix: { status: "completed", result: { findings: ["fixed"], artifacts: [] } },
    }));
    assert.equal(r.status, "completed");
    assert.equal(r.waves.length, 3, "wave0: auth+login, wave1: review, wave2: fix");
    assert.deepEqual(Object.keys(r.finalContext).sort(), ["auth", "fix", "login", "review"]);
  });

  it("mid-DAG failure isolates: failed node does not abort siblings or the pipeline", async () => {
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
      c: { role: "reviewer", task: "[node:c] review", depends_on: ["a", "b"] },
    }};
    // a fails, b succeeds → wave0 partial; c still runs with error context for a.
    const r = await executeDAG(spec, serviceShapedSpawn({
      a: { status: "failed", error: "compile error" },
      b: { status: "completed", result: { findings: ["b done"], artifacts: [] } },
      c: { status: "completed", result: { findings: ["c reviewed despite a failing"], artifacts: [] } },
    }));
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1);
    assert.equal(r.waves[0].successes.length, 1, "b succeeded despite a failing in the same wave");
    assert.ok(r.finalContext.b, "b's result preserved");
    assert.ok(r.finalContext.c, "c ran and its result preserved (downstream continued)");
  });

  it("minimal DAG completes without rejecting", async () => {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] x" } }};
    await assert.doesNotReject(async () => executeDAG(spec, serviceShapedSpawn({})));
  });
});
