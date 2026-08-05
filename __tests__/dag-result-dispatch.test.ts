import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deserializeCheckpoint,
  makeCheckpointV2,
  resumeDAG,
  serializeCheckpoint,
} from "../src/dag/checkpoint";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import type { DAGExecutionSnapshot, DAGSpec, NodePayload } from "../src/dag/types";

function completed(id: string, payload: NodePayload) {
  return {
    agentId: id,
    wait: async () => ({ status: "completed" as const, reportPayload: payload }),
  };
}

function resultDispatchSpec(): DAGSpec {
  return { nodes: {
    fanout: {
      role: "planner",
      task: "Choose independent checks",
      expected_output: "Merged verified checks",
      consumers: ["final"],
      dispatch: { maxChildren: 4 },
    },
    final: {
      role: "reviewer",
      task: "Decide from the checks",
      depends_on: ["fanout"],
      expected_output: "A verified decision",
      consumers: ["$result"],
    },
  } };
}

describe("agent-result-driven DAG dispatch", () => {
  it("spawns a dispatcher, validates its result atomically, then schedules generated children", async () => {
    const spec = resultDispatchSpec();
    const spawned: string[] = [];
    const checkpoints: DAGExecutionSnapshot[] = [];
    let finalTask = "";
    let observedLimit: number | undefined;
    const result = await executeDAGCore(spec, async (role, task, _roleDef, _model, _thinking, _routes, dispatchLimit) => {
      spawned.push(`${role}:${task.split("\n", 1)[0]}`);
      if (role === "planner") {
        observedLimit = dispatchLimit;
        return completed("planner", {
          findings: ["two checks selected"],
          artifacts: [],
          sends: [
            { key: "api", role: "coder", arg: "check api", expected_output: "API result", consumers: ["$parent"] },
            { key: "ui", role: "reviewer", arg: "check ui", expected_output: "UI result", consumers: ["$parent"] },
          ],
        });
      }
      if (task.startsWith("Decide")) finalTask = task;
      return completed(task, {
        findings: [task.startsWith("check api") ? "api-ok" : task.startsWith("check ui") ? "ui-ok" : "decision"],
        artifacts: [],
      });
    }, {
      knownRoles: new Set(["planner", "coder", "reviewer"]),
      maxConcurrent: 2,
      onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    });

    assert.equal(result.status, "completed");
    assert.equal(observedLimit, 4);
    assert.deepEqual(spawned.map((entry) => entry.split(":", 1)[0]), ["planner", "coder", "reviewer", "reviewer"]);
    assert.deepEqual(result.finalContext.fanout.findings, ["two checks selected", "api-ok", "ui-ok"]);
    assert.match(finalTask, /two checks selected/);
    assert.match(finalTask, /api-ok/);
    assert.match(finalTask, /ui-ok/);
    const expanded = checkpoints.find((snapshot) =>
      snapshot.nodeStates["fanout::api"]?.status === "queued"
      && snapshot.nodeStates["fanout::ui"]?.status === "queued");
    assert.ok(expanded, "expanded graph is checkpointed before generated children launch");
    assert.equal(expanded.dispatchExpansions.fanout.source, "result");
    assert.deepEqual(expanded.dispatchExpansions.fanout.dispatcherResult?.findings, ["two checks selected"]);
  });

  it("fails the whole generated batch before any child spawn when the dispatcher result is invalid", async () => {
    let childSpawns = 0;
    let finalTask = "";
    const result = await executeDAGCore(resultDispatchSpec(), async (role, task) => {
      if (role === "planner") {
        return completed("planner", {
          findings: ["bad plan"],
          artifacts: [],
          sends: [
            { key: "same", role: "coder", arg: "one", expected_output: "one", consumers: ["$parent"] },
            { key: "same", role: "missing", arg: "two", expected_output: "two", consumers: ["$parent"] },
          ],
        });
      }
      if (task.startsWith("Decide")) finalTask = task;
      else childSpawns++;
      return completed(task, { findings: ["handled"], artifacts: [] });
    }, { knownRoles: new Set(["planner", "coder", "reviewer"]) });

    assert.equal(childSpawns, 0);
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /duplicate send key|unknown role/);
    assert.match(finalTask, /Predecessor 'fanout' failed/);
  });

  it("requires the spawned dispatcher to return a structured sends array", async () => {
    let childSpawns = 0;
    const result = await executeDAGCore({ nodes: {
      fanout: {
        role: "planner",
        task: "choose",
        expected_output: "Selected child work",
        consumers: ["$result"],
        dispatch: {},
      },
    } }, async () => {
      childSpawns++;
      return completed("planner", { findings: ["no sends"], artifacts: [] });
    }, { knownRoles: new Set(["planner"]) });
    assert.equal(childSpawns, 1, "only the dispatcher itself spawned");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /must return a top-level sends array/);
  });

  it("resumes an expanded result dispatch without rerunning the dispatcher", async () => {
    const spec = resultDispatchSpec();
    const controller = new AbortController();
    let expansionSnapshot: DAGExecutionSnapshot | undefined;
    let dispatcherCalls = 0;
    await executeDAGCore(spec, async (role) => {
      if (role === "planner") dispatcherCalls++;
      return completed(role ?? "default", {
        findings: ["planned"],
        artifacts: [],
        sends: [{ key: "api", role: "coder", arg: "check api", expected_output: "API result", consumers: ["$parent"] }],
      });
    }, {
      knownRoles: new Set(["planner", "coder", "reviewer"]),
      signal: controller.signal,
      onCheckpoint: (snapshot) => {
        if (snapshot.nodeStates["fanout::api"]?.status === "queued") {
          expansionSnapshot = snapshot;
          controller.abort();
        }
      },
    });
    assert.ok(expansionSnapshot);

    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, expansionSnapshot!)));
    const resumedSpawns: string[] = [];
    const result = await resumeDAG(checkpoint, async (role, task) => {
      resumedSpawns.push(`${role}:${task.split("\n", 1)[0]}`);
      return completed(task, { findings: [task.startsWith("check api") ? "api-resumed" : "done"], artifacts: [] });
    }, { knownRoles: new Set(["planner", "coder", "reviewer"]) });

    assert.equal(dispatcherCalls, 1);
    assert.equal(resumedSpawns.some((entry) => entry.startsWith("planner:")), false);
    assert.deepEqual(resumedSpawns.map((entry) => entry.split(":", 1)[0]), ["coder", "reviewer"]);
    assert.deepEqual(result.finalContext.fanout.findings, ["planned", "api-resumed"]);
    assert.equal(result.status, "completed");
  });

  it("rejects result dispatch combined with conditional routes", () => {
    const validationSpec: DAGSpec = { nodes: {
      decide: { task: "decide and dispatch", dispatch: {}, routes: { yes: ["yes"] } },
      yes: { task: "yes", depends_on: ["decide"] },
    } };
    assert.rejects(
      executeDAGCore(validationSpec, async () => completed("unused", { findings: [], artifacts: [] })),
      /cannot combine routes with dispatch/,
    );
  });
});
