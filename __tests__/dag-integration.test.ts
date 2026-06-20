import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";
import { executeDAG, type SpawnFn, type SpawnOutcomeStatus } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";

// Integration: the DAG executor composed with the REAL SubagentsService (spawn
// returns an id; waitForResult awaits the completion promise) via a SpawnFn
// adapter — NOT a trivial fake spawnFn. A fake session stands in for the live
// pi runtime (no createAgentSession/provider), so this verifies the
// executor↔service seam + multi-wave orchestration + aggregation.
//
// The real-pi spawn path (background mode, no clone error, no deadlock) is
// verified separately by the goal session having actually spawned 2 roles via
// spawn_role({mode:'background'}) → both completed with zero 'could not be
// cloned' errors (clone bug fixed by Task 1 — no handle constructed on spawn).

function makeFakeSession(turns: number, assistantText = "done"): SubagentSession {
  const listeners: Array<(e: any) => void> = [];
  let aborted = false;
  return {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => { aborted = true; },
    prompt: async () => {
      for (let i = 0; i < turns; i++) {
        if (aborted) break;
        listeners.forEach((l) => l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } }));
        listeners.forEach((l) => l({ type: "turn_end" }));
        await new Promise((r) => setTimeout(r, 1));
      }
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  } as SubagentSession;
}

// Fresh fake session per createSession so concurrent wave spawns don't share state.
function makeDeps(turns: number, assistantText = "done"): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => "/tmp/child.jsonl",
    }) as any,
    createSession: async () => ({ session: makeFakeSession(turns, assistantText) }),
  };
}

// Map a SubagentRecord (from service.waitForResult) to the executor's SpawnHandle
// wait-result shape: terminal status → SpawnOutcomeStatus; assistant text →
// findings (no report_role_result payload in the fake-session path).
function recToWaitResult(rec: { status: string; result?: string; error?: string; reportPayload?: { findings: string[]; artifacts: string[] } }) {
  const status: SpawnOutcomeStatus = rec.status === "completed" ? "completed" : rec.status === "aborted" ? "aborted" : "error";
  return {
    status,
    result: rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] },
    error: rec.error,
    reportPayload: rec.reportPayload,
  };
}

// SpawnFn adapter: drives the REAL SubagentsService — spawn (non-blocking) → id;
// wait() → waitForResult(id) mapped to the executor's shape.
function serviceSpawnFn(service: SubagentsService, maxTurns = 3): SpawnFn {
  return async (role, task) => {
    const id = service.spawn({ role, task, maxTurns, parentSessionId: "dag-parent" });
    return { agentId: id, wait: async () => recToWaitResult(await service.waitForResult(id)) };
  };
}

describe("dag integration — executor over real SubagentsService", () => {
  it("2-wave DAG: 2 coders → reviewer, all complete through the real service", async () => {
    const service = new SubagentsService(makeDeps(1, "node-output"), { cwd: "/p", agentDir: "/.pi" });
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
      c: { role: "reviewer", task: "[node:c] review", depends_on: ["a", "b"] },
    }};
    const r = await executeDAG(spec, serviceSpawnFn(service));
    assert.equal(r.status, "completed");
    assert.equal(r.waves.length, 2, "wave0: a+b parallel, wave1: c");
    assert.equal(r.waves[0].successes.length, 2);
    assert.equal(r.waves[1].successes.length, 1);
    // assistant text flows through as findings (no report_payload → fallback wraps result)
    assert.ok(r.finalContext.a.findings.includes("node-output"));
    assert.ok(r.finalContext.c.findings.includes("node-output"));
  });

  it("partial failure: a node that aborts (step-limit) does NOT abort its sibling", async () => {
    // one session aborts at step-limit; service uses maxTurns to enforce it.
    const service = new SubagentsService(makeDeps(2, "ok"), { cwd: "/p", agentDir: "/.pi" });
    const spawnFn: SpawnFn = async (role, task) => {
      // node 'a' hits step-limit (maxTurns=1 < 2 turns → abort); node 'b' completes (maxTurns=10 > 2 turns)
      const maxTurns = task.includes("[node:a]") ? 1 : 10;
      const id = service.spawn({ role, task, maxTurns, parentSessionId: "dag-parent" });
      return { agentId: id, wait: async () => recToWaitResult(await service.waitForResult(id)) };
    };
    const spec: DAGSpec = { nodes: {
      a: { role: "coder", task: "[node:a] do a" },
      b: { role: "coder", task: "[node:b] do b" },
    }};
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "partial");
    assert.equal(r.waves[0].failures.length, 1, "node a aborted (step-limit) → failed");
    assert.equal(r.waves[0].successes.length, 1, "node b still completed (sibling isolation through real service)");
  });
});
