import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import { classifyDAGError } from "../src/dag/error-taxonomy";
import type { DAGSpec } from "../src/dag/types";

describe("DAG runtime V3 error and retry contract", () => {
  it("normalizes provider, rate-limit, worker, timeout, and content failures", () => {
    assert.equal(classifyDAGError({ status: 429, message: "too many requests" }).code, "rate_limit");
    assert.equal(classifyDAGError(new Error("provider abort")).code, "provider_abort");
    assert.equal(classifyDAGError(new Error("worker process crashed")).code, "worker_crash");
    assert.equal(classifyDAGError(new Error("timeout after 5ms")).code, "timeout");
    assert.equal(classifyDAGError(new Error("verification check failed")).code, "verification_failed");
  });

  it("retries only a typed infrastructure failure and rolls node attempt lineage", async () => {
    let calls = 0;
    const attempts: Array<{ attemptNumber: number; status: string }> = [];
    const spec: DAGSpec = { lineage: { workflowId: "wf-retry" }, nodes: { work: { task: "work" } } };
    const spawn: SpawnFn = async () => ({
      agentId: `agent-${calls + 1}`,
      wait: async () => {
        calls++;
        return calls === 1
          ? { status: "error" as const, error: "429 rate limit" }
          : { status: "completed" as const, result: { findings: ["done"], artifacts: [] } };
      },
    });
    const result = await executeDAGCore(spec, spawn, {
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      onAttempt: (event) => attempts.push({ attemptNumber: event.attemptNumber, status: event.status }),
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "completed");
    assert.deepEqual(attempts.map((event) => event.status), ["started", "retrying", "started", "completed"]);
    const node = result.waves[0].successes[0];
    assert.equal(node.attemptNumber, 2);
    assert.match(node.resultId ?? "", /:result:attempt:2$/);
    assert.equal(node.lineage?.attemptNumber, 2);
  });

  it("does not retry verification failures even when retries are enabled", async () => {
    let calls = 0;
    const spawn: SpawnFn = async () => ({
      agentId: "agent",
      wait: async () => { calls++; return { status: "failed" as const, error: "verification check failed" }; },
    });
    const result = await executeDAGCore({ nodes: { work: { task: "work" } } }, spawn, {
      retryPolicy: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    });
    assert.equal(calls, 1);
    assert.equal(result.waves[0].failures[0].errorInfo?.code, "verification_failed");
  });

  it("keeps the legacy string error projection for old consumers", async () => {
    const result = await executeDAGCore({ nodes: { work: { task: "work" } } }, async () => ({
      agentId: "agent",
      wait: async () => ({ status: "failed" as const, error: "worker process crashed" }),
    }));
    assert.equal(result.waves[0].failures[0].error, "worker process crashed");
    assert.equal(result.waves[0].failures[0].errorInfo?.code, "worker_crash");
  });
});
