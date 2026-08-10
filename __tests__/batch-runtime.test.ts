import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeBatchManifest, selectBatchTasks, type BatchManifestV1 } from "../src/dag/batch-runtime";

const manifest: BatchManifestV1<{ value: string }> = {
  schemaVersion: 1,
  id: "batch-1",
  maxConcurrent: 2,
  tasks: [
    { id: "a", spec: { value: "a" }, runId: "run-a", attemptId: "run-a:attempt:1", resourceScopes: ["file://repo/shared/**"] },
    { id: "b", spec: { value: "b" }, runId: "run-b", attemptId: "run-b:attempt:1", resourceScopes: ["file://repo/shared/b.md"] },
    { id: "c", spec: { value: "c" }, runId: "run-c", attemptId: "run-c:attempt:1", resourceScopes: ["file://repo/other/**"] },
  ],
};

describe("batch runtime V1", () => {
	it("returns validation diagnostics for malformed external JSON", () => {
		assert.throws(() => selectBatchTasks({ schemaVersion: 1, id: "bad", maxConcurrent: 1, tasks: null } as any, undefined, "all"), /batch tasks must be an array/);
	});
  it("honors max concurrency and serializes overlapping resources", async () => {
    let active = 0;
    let peak = 0;
    let sharedActive = 0;
    let sharedPeak = 0;
    const result = await executeBatchManifest(manifest, async (task) => {
      active++;
      peak = Math.max(peak, active);
      if (task.id !== "c") { sharedActive++; sharedPeak = Math.max(sharedPeak, sharedActive); }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (task.id !== "c") sharedActive--;
      active--;
      return { status: "completed", value: task.spec.value };
    });
    assert.equal(result.status, "completed");
    assert.equal(result.completed, 3);
    assert.equal(peak, 2);
    assert.equal(sharedPeak, 1);
  });

  it("retries only retryable failures and advances the prior attempt lineage", async () => {
    const prior = {
      batchId: "batch-1", status: "partial" as const, total: 3, completed: 1, failed: 2, cancelled: 0,
      results: [
        { taskId: "a", runId: "run-a", attemptId: "run-a:attempt:1", status: "completed" as const, value: "old-a" },
        { taskId: "b", runId: "run-b", attemptId: "run-b:attempt:7", status: "failed" as const, error: { code: "rate_limit", message: "429", retryable: true } },
        { taskId: "c", runId: "run-c", attemptId: "run-c:attempt:2", status: "failed" as const, error: { code: "verification_failed", message: "bad", retryable: false } },
      ],
    };
    const selected = selectBatchTasks(manifest, prior, "failed_only");
    assert.deepEqual(selected.map((task) => [task.id, task.attemptId]), [["b", "run-b:attempt:8"]]);
    const result = await executeBatchManifest(manifest, async (task) => ({ status: "completed", value: `new-${task.id}` }), { mode: "failed_only", prior });
    assert.equal(result.status, "partial");
    assert.equal(result.results.find((item) => item.taskId === "a")?.value, "old-a");
    assert.equal(result.results.find((item) => item.taskId === "b")?.attemptId, "run-b:attempt:8");
    assert.equal(result.results.find((item) => item.taskId === "c")?.status, "failed");
  });

  it("turns executor exceptions into typed non-retryable task failures", async () => {
    const one = { ...manifest, tasks: [manifest.tasks[0]] };
    const result = await executeBatchManifest(one, async () => { throw new Error("boom"); });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.results[0].error, { code: "internal", message: "boom", retryable: false });
  });
});
