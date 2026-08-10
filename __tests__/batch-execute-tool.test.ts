import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeBatchExecuteTool } from "../src/dag/batch-execute-tool";

describe("batch_execute tool contract", () => {
  it("validates the manifest before spawning children", async () => {
    let calls = 0;
    const tool = makeBatchExecuteTool({
      roleRegistry: new Map(), service: { spawn: () => { calls++; throw new Error("must not spawn"); } } as any,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: ".", agentDir: ".",
    }) as any;
		const result = await tool.execute("call-1", { manifest: { schemaVersion: 1, id: "bad", maxConcurrent: 1, tasks: [{ id: "a", runId: "r", attemptId: "a", spec: { task: "a" }, resourceScopes: ["not-uri"] }] } }, new AbortController().signal, undefined, {});
		assert.equal(result.details.status, "error");
		assert.match(result.details.errors.join(" "), /invalid resource scope/);
    assert.equal(calls, 0);
  });

	it("executes a valid manifest through the role spawn adapter", async () => {
		const spawned: string[] = [];
		const service = {
			spawn: (options: any) => { spawned.push(options.task); return `agent-${spawned.length}`; },
			waitForResult: async (id: string) => ({ status: "completed", result: id, reportPayload: { findings: [id], artifacts: [] } }),
			abort: () => true,
		};
		const tool = makeBatchExecuteTool({
			roleRegistry: new Map(), service: service as any,
			reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: ".", agentDir: ".",
		}) as any;
		const result = await tool.execute("call-2", { manifest: { schemaVersion: 1, id: "batch", maxConcurrent: 2, tasks: [
			{ id: "a", runId: "run-a", attemptId: "attempt-a", spec: { task: "task a" } },
			{ id: "b", runId: "run-b", attemptId: "attempt-b", spec: { task: "task b" } },
		] } }, new AbortController().signal, undefined, {});
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.completed, 2);
		assert.deepEqual(new Set(spawned), new Set(["task a", "task b"]));
	});
});
