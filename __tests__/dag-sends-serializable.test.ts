import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn } from "../src/dag/executor";
import { serializeCheckpoint, deserializeCheckpoint, makeCheckpoint, resumeDAG } from "../src/dag/checkpoint";
import type { DAGSpec, NodePayload } from "../src/dag/types";

function spawnRecording(spec: DAGSpec): { spawnFn: SpawnFn; tasks: string[] } {
  const tasks: string[] = [];
  const spawnFn: SpawnFn = async (_role, task) => {
    tasks.push(task);
    const m = task.match(/\[node:([^\]]+)\]/);
    const nodeId = m ? m[1] : task;
    return { agentId: nodeId, wait: async () => ({ status: "completed", reportPayload: { findings: [nodeId], artifacts: [] } as NodePayload }) };
  };
  return { spawnFn, tasks };
}

describe("dag executor — serializable Send-as-data (SOTA gap #3)", () => {
  it("DAGNode.sends fans out N parallel spawns exactly like DynamicNode", async () => {
    const spec: DAGSpec = { nodes: {
      fan: {
        role: "planner",
        task: "[node:fan] (ignored — sends used)",
        sends: [
          { role: "coder", arg: "[node:fan] sub-A" },
          { role: "coder", arg: "[node:fan] sub-B" },
          { role: "coder", arg: "[node:fan] sub-C" },
        ],
      },
    }};
    const { spawnFn, tasks } = spawnRecording(spec);
    const r = await executeDAG(spec, spawnFn);
    assert.equal(r.status, "completed");
    assert.equal(tasks.length, 3, "3 sends fanned out");
    // Dynamic node title task NOT called — sends bypass it
    assert.equal(tasks.some(t => t.includes("ignored")), false, "static task NOT called when sends present");
    // Merged result: 3 findings under 'fan'
    assert.equal(r.finalContext.fan.findings.length, 3);
  });

  it("Checkpoint round-trip: sends-based DAG survives serialize+deserialize+resume", async () => {
    // 2-wave DAG: wave 0 = static coder (checkpointed), wave 1 = sends-based fanout
    const spec: DAGSpec = { nodes: {
      prep: { role: "coder", task: "[node:prep] prepare" },
      fanout: {
        role: "planner",
        task: "[node:fanout] (ignored)",
        depends_on: ["prep"],
        sends: [
          { role: "coder", arg: "[node:fanout] w1" },
          { role: "coder", arg: "[node:fanout] w2" },
        ],
      },
    }};
    // Run wave 0 only (simulate crash)
    const cp = makeCheckpoint(spec, [
      { wave: 0, successes: [{ nodeId: "prep", status: "completed", result: { findings: ["prep-done"], artifacts: [] } }], failures: [] },
    ]);
    const json = serializeCheckpoint(cp);
    // Round-trip
    const back = deserializeCheckpoint(json);
    assert.equal(back.spec.nodes.fanout.sends?.length, 2, "sends preserved through JSON round-trip");

    // Resume
    const { spawnFn, tasks } = spawnRecording(spec);
    const r = await resumeDAG(back, spawnFn);
    assert.equal(r.status, "completed");
    // prep NOT re-spawned; fanout's 2 sends were spawned
    const fanoutSpawns = tasks.filter(t => !t.includes("prep"));
    assert.equal(fanoutSpawns.length, 2, "resume fanned out 2 sends in pending wave");
    assert.deepEqual(r.finalContext.prep.findings, ["prep-done"], "checkpointed result preserved");
    assert.equal(r.finalContext.fanout.findings.length, 2, "fanout results merged on resume");
  });
});
