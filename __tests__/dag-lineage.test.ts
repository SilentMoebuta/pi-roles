import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deserializeCheckpoint, makeCheckpointV2, resumeDAG, serializeCheckpoint } from "../src/dag/checkpoint";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import type { DAGExecutionSnapshot, DAGSpec } from "../src/dag/types";

const spec: DAGSpec = {
  lineage: { goalDefinitionId: "g1", revisionId: "rev1", runId: "run1", attemptId: "attempt1" },
  nodes: {
    first: { task: "first" },
    second: { task: "second", depends_on: ["first"] },
  },
};

const spawn: SpawnFn = async (_role, task) => ({
  agentId: task,
  wait: async () => ({ status: "completed", result: { findings: [task], artifacts: [] } }),
});

describe("DAG workflow lineage", () => {
  it("adds stable workflow and node result identities", async () => {
    const result = await executeDAGCore(spec, spawn, { now: () => 100, workflow: { workflowId: "wf-1" } });
    assert.equal(result.workflow?.workflowId, "wf-1");
    assert.equal(result.workflow?.attemptId, "attempt1");
    const results = result.waves.flatMap((wave) => [...wave.successes, ...wave.failures]);
    assert.deepEqual(results.map((entry) => entry.resultId), ["wf-1:node:first:result", "wf-1:node:second:result"]);
    assert.ok(results.every((entry) => entry.lineage?.runId === "run1"));
  });

  it("preserves the workflow identity and result envelope through checkpoint resume", async () => {
    let snapshot: DAGExecutionSnapshot | undefined;
    await executeDAGCore(spec, spawn, {
      now: () => 200,
      workflow: { workflowId: "wf-resume" },
      onCheckpoint: (value) => { snapshot = value; },
    });
    assert.ok(snapshot);
    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, snapshot!)));
    const resumed = await resumeDAG(checkpoint, spawn, { now: () => 300 });
    assert.equal(resumed.workflow?.workflowId, "wf-resume");
    const results = resumed.waves.flatMap((wave) => wave.successes);
    assert.ok(results.every((entry) => entry.lineage?.workflowId === "wf-resume"));
  });

  it("persists runtime checkpoint material and rejects tampering", async () => {
    let snapshot: DAGExecutionSnapshot | undefined;
    await executeDAGCore(spec, spawn, {
      workflow: { workflowId: "wf-checkpoint-integrity" },
      checkpointRuntime: {
        artifactDigests: { out: { uri: "out.md", digest: "a".repeat(64), sizeBytes: 4, verifiedAt: 100 } },
        approvals: { write: { decision: "granted", capability: "filesystem.write", scope: "docs/**", revisionId: "rev1", decidedAt: 100 } },
        sideEffectJournal: { mail: { idempotencyKey: "mail-1", operation: "send", resource: "mailbox://ops", requestDigest: "b".repeat(64), status: "committed", attemptId: "attempt1", completedAt: 100 } },
      },
      onCheckpoint: (value) => { snapshot = value; },
    });
    assert.ok(snapshot);
    const checkpoint = makeCheckpointV2(spec, snapshot!);
    assert.match(checkpoint.checkpointDigest ?? "", /^[0-9a-f]{64}$/);
    const parsed = deserializeCheckpoint(serializeCheckpoint(checkpoint)) as any;
    assert.equal(parsed.sideEffectJournal.mail.status, "committed");
    const forged = JSON.parse(serializeCheckpoint(checkpoint));
    forged.approvals.write.decision = "denied";
    assert.throws(() => deserializeCheckpoint(JSON.stringify(forged)), /digest mismatch/);
  });
});
