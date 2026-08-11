import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeDagResumeTool } from "../src/dag/dag-resume-tool";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import { deserializeCheckpoint, makeCheckpoint, makeCheckpointV2, resumeDAG, serializeCheckpoint, type DAGCheckpointV2 } from "../src/dag/checkpoint";
import type { DagExecuteDeps } from "../src/dag/dag-execute-tool";
import { makeWorkflowExecuteTool } from "../src/dag/workflow-execute-tool";
import type { DAGExecutionSnapshot, DAGSpec, WaveResult } from "../src/dag/types";
import type { ReportState } from "../src/report-tool";

function deps(service: any): DagExecuteDeps {
  return {
    roleRegistry: new Map(),
    service,
    reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
    cwd: "/tmp",
    agentDir: "/tmp",
  };
}

function retryingService(firstFailure: string) {
  const spawns: Array<{ id: string; task: string }> = [];
  let nextId = 0;
  return {
    spawns,
    service: {
      spawn: (params: any) => {
        const id = `child-${++nextId}`;
        spawns.push({ id, task: params.task });
        return id;
      },
      waitForResult: async (id: string) => id === "child-1"
        ? { id, status: "error", error: firstFailure, turnCount: 1 }
        : { id, status: "completed", turnCount: 1, reportPayload: { findings: [`${id}-ok`], artifacts: [] } },
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    },
  };
}

describe("P1 live workflow fault matrix", () => {
  for (const scenario of [
    { name: "provider abort", message: "provider abort", code: "provider_abort" },
    { name: "429 rate limit", message: "429 rate limit", code: "rate_limit" },
    { name: "worker crash", message: "worker process crashed", code: "worker_crash" },
  ]) {
    it(`retries ${scenario.name} through workflow_execute without replaying the completed predecessor`, async () => {
      const { spawns, service } = retryingService(scenario.message);
      const tool = makeWorkflowExecuteTool(deps(service)) as any;
      const result = await tool.execute("workflow-fault", {
        workflow: {
          schemaVersion: 1,
          id: `fault-${scenario.code}`,
          kind: "sequential",
          tasks: [
            { id: "effect", task: "perform effect" },
            { id: "finalize", task: "finalize result" },
          ],
        },
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }, new AbortController().signal, undefined, {});

      assert.equal(result.details.status, "completed");
      assert.equal(spawns.filter((entry) => entry.task.startsWith("perform effect")).length, 2);
      assert.equal(spawns.filter((entry) => entry.task.startsWith("finalize result")).length, 1);
      assert.deepEqual(
        result.details.attempts.map((event: any) => [event.nodeId, event.attemptNumber, event.status, event.error?.code ?? null]),
        [
          ["effect", 1, "started", null],
          ["effect", 1, "retrying", scenario.code],
          ["effect", 2, "started", null],
          ["effect", 2, "completed", null],
          ["finalize", 1, "started", null],
          ["finalize", 1, "completed", null],
        ],
      );
    });
  }

  it("forwards the typed retry policy through dag_resume and does not replay a completed node", async () => {
    const spec: DAGSpec = { nodes: {
      prepared: { task: "prepared work" },
      pending: { task: "pending work", depends_on: ["prepared"] },
    } };
    const completedWave: WaveResult = {
      wave: 0,
      successes: [{ nodeId: "prepared", status: "completed", result: { findings: ["prepared"], artifacts: [] } }],
      failures: [],
    };
    const { spawns, service } = retryingService("worker process crashed");
    const tool = makeDagResumeTool(deps(service)) as any;
    const result = await tool.execute("resume-fault", {
      checkpoint: serializeCheckpoint(makeCheckpoint(spec, [completedWave])),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    }, new AbortController().signal, undefined, {});

    assert.equal(result.details.status, "completed");
    assert.equal(spawns.filter((entry) => entry.task.startsWith("prepared work")).length, 0);
    assert.equal(spawns.filter((entry) => entry.task.startsWith("pending work")).length, 2);
    assert.deepEqual(result.details.attempts.map((event: any) => event.status), ["started", "retrying", "started", "completed"]);
  });

  it("applies the same typed retry contract to bounded loop iterations", async () => {
    let calls = 0;
    const service = {
      spawn: () => `loop-${++calls}`,
      waitForResult: async (id: string) => id === "loop-1"
        ? { id, status: "error", error: "worker process crashed", turnCount: 1 }
        : { id, status: "completed", turnCount: 1, reportPayload: { findings: ["done"], artifacts: [], done: true } },
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    };
    const tool = makeWorkflowExecuteTool(deps(service)) as any;
    const result = await tool.execute("loop-fault", {
      workflow: {
        schemaVersion: 1,
        id: "loop-retry",
        kind: "loop",
        tasks: [{ id: "refine", task: "refine" }],
        loop: { maxIterations: 2, until: "done" },
      },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    }, new AbortController().signal, undefined, {});

    assert.equal(result.details.status, "completed");
    assert.equal(calls, 2);
    assert.deepEqual(result.details.attempts.map((event: any) => [event.attemptNumber, event.status, event.error?.code ?? null]), [
      [1, "started", null],
      [1, "retrying", "worker_crash"],
      [2, "started", null],
      [2, "completed", null],
    ]);
  });

  it("does not retry a non-retryable bounded-loop failure", async () => {
    let calls = 0;
    const service = {
      spawn: () => `loop-${++calls}`,
      waitForResult: async (id: string) => ({ id, status: "failed", error: "verification check failed", turnCount: 1 }),
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    };
    const tool = makeWorkflowExecuteTool(deps(service)) as any;
    const result = await tool.execute("loop-content-failure", {
      workflow: {
        schemaVersion: 1,
        id: "loop-content-failure",
        kind: "loop",
        tasks: [{ id: "refine", task: "refine" }],
        loop: { maxIterations: 2, until: "done" },
      },
      retryPolicy: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    }, new AbortController().signal, undefined, {});

    assert.equal(result.details.status, "failed");
    assert.equal(calls, 1);
    assert.deepEqual(result.details.attempts.map((event: any) => [event.attemptNumber, event.status, event.error?.code ?? null]), [
      [1, "started", null],
      [1, "failed", "verification_failed"],
    ]);
  });

  it("preserves one-attempt behavior when a loop retry policy is omitted", async () => {
    let calls = 0;
    const service = {
      spawn: () => `loop-${++calls}`,
      waitForResult: async (id: string) => ({ id, status: "error", error: "429 rate limit", turnCount: 1 }),
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    };
    const tool = makeWorkflowExecuteTool(deps(service)) as any;
    const result = await tool.execute("loop-default", {
      workflow: {
        schemaVersion: 1,
        id: "loop-default",
        kind: "loop",
        tasks: [{ id: "refine", task: "refine" }],
        loop: { maxIterations: 2, until: "done" },
      },
    }, new AbortController().signal, undefined, {});

    assert.equal(result.details.status, "failed");
    assert.equal(calls, 1);
    assert.deepEqual(result.details.attempts.map((event: any) => [event.attemptNumber, event.status, event.error?.code ?? null]), [
      [1, "started", null],
      [1, "failed", "rate_limit"],
    ]);
  });

  it("preserves one-attempt behavior for an acyclic workflow when retryPolicy is omitted", async () => {
    const { spawns, service } = retryingService("worker process crashed");
    const tool = makeWorkflowExecuteTool(deps(service)) as any;
    const result = await tool.execute("workflow-default", {
      workflow: {
        schemaVersion: 1,
        id: "workflow-default",
        kind: "direct",
        tasks: [{ id: "work", task: "work" }],
      },
    }, new AbortController().signal, undefined, {});

    assert.equal(result.details.status, "failed");
    assert.equal(spawns.length, 1);
    assert.deepEqual(result.details.attempts.map((event: any) => [event.attemptNumber, event.status, event.error?.code ?? null]), [
      [1, "started", null],
      [1, "failed", "worker_crash"],
    ]);
  });

  it("makes duplicate terminal resume a no-op and protects the committed side-effect journal digest", async () => {
    const spec: DAGSpec = { lineage: { workflowId: "wf-terminal-replay" }, nodes: { done: { task: "done" } } };
    let terminalSnapshot: DAGExecutionSnapshot | undefined;
    const initialSpawn: SpawnFn = async () => ({
      agentId: "initial",
      wait: async () => ({ status: "completed", result: { findings: ["done"], artifacts: [] } }),
    });
    await executeDAGCore(spec, initialSpawn, {
      checkpointRuntime: {
        artifactDigests: {},
        approvals: {},
        sideEffectJournal: {
          effect: {
            idempotencyKey: "effect-1",
            operation: "send",
            resource: "queue://jobs/1",
            requestDigest: "a".repeat(64),
            status: "committed",
            attemptId: "attempt-1",
            completedAt: 100,
          },
        },
      },
      onCheckpoint: (snapshot) => { terminalSnapshot = snapshot; },
    });
    assert.ok(terminalSnapshot);
    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, terminalSnapshot!))) as DAGCheckpointV2;
    assert.equal(checkpoint.sideEffectJournal?.effect.status, "committed");

    let replaySpawns = 0;
    const rejectReplay: SpawnFn = async () => {
      replaySpawns++;
      throw new Error("terminal workflow must not spawn");
    };
    const first = await resumeDAG(checkpoint, rejectReplay);
    const second = await resumeDAG(checkpoint, rejectReplay);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(replaySpawns, 0);

    const forged = JSON.parse(serializeCheckpoint(checkpoint));
    forged.sideEffectJournal.effect.status = "failed";
    assert.throws(() => deserializeCheckpoint(JSON.stringify(forged)), /checkpoint digest mismatch/);
  });
});
