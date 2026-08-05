import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deserializeCheckpoint,
  makeCheckpointV2,
  resumeDAG,
  serializeCheckpoint,
} from "../src/dag/checkpoint";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import { expandDispatchNode } from "../src/dag/expansion";
import type { DAGExecutionSnapshot, DAGSpec, NodePayload } from "../src/dag/types";

function complete(id: string, findings: string[] = [id]) {
  return {
    agentId: id,
    wait: async () => ({
      status: "completed" as const,
      reportPayload: { findings, artifacts: [] },
    }),
  };
}

function fanoutSpec(): DAGSpec {
  return { nodes: {
    fanout: {
      task: "Dispatch checks",
      expected_output: "Merged check results",
      consumers: ["final"],
      dispatch: { maxChildren: 4 },
      sends: [
        { key: "api", role: "coder", arg: "check api", expected_output: "API result", consumers: ["$parent"] },
        { key: "ui", role: "reviewer", arg: "check ui", expected_output: "UI result", consumers: ["$parent"] },
      ],
    },
    final: {
      task: "integrate checks",
      depends_on: ["fanout"],
      expected_output: "Integrated decision",
      consumers: ["$result"],
    },
  } };
}

describe("scheduler-visible generated dispatch", () => {
  it("completes a dispatcher-only DAG without requiring a synthetic final node", async () => {
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch independent checks",
        expected_output: "Merged checks",
        consumers: ["$result"],
        dispatch: {},
        sends: [{ key: "one", role: "coder", arg: "check one", expected_output: "One check", consumers: ["$parent"] }],
      },
    } };
    const result = await executeDAGCore(spec, async (_role, task) => complete(task, ["one-ok"]));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.finalContext.fanout.findings, ["one-ok"]);
    assert.equal(result.nodeStates?.["fanout::one"].status, "completed");
  });

  it("completes an empty dispatcher-only expansion as an empty aggregate", async () => {
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch optional checks",
        expected_output: "Merged optional checks",
        consumers: ["$result"],
        dispatch: {},
        sends: [],
      },
    } };
    let spawnCount = 0;
    const result = await executeDAGCore(spec, async () => {
      spawnCount++;
      return complete("unexpected");
    });
    assert.equal(result.status, "completed");
    assert.equal(spawnCount, 0);
    assert.deepEqual(result.finalContext.fanout, { findings: [], artifacts: [] });
  });

  it("persists expanded topology before spawning children and mechanically joins their results", async () => {
    const spec = fanoutSpec();
    const progress: DAGExecutionSnapshot["expandedSpec"][] = [];
    const checkpoints: DAGExecutionSnapshot[] = [];
    const spawned: string[] = [];
    let finalTask = "";
    const result = await executeDAGCore(spec, async (_role, task) => {
      spawned.push(task);
      if (task.startsWith("integrate checks")) finalTask = task;
      const finding = task.startsWith("check api") ? "api-ok" : task.startsWith("check ui") ? "ui-ok" : "integrated";
      return complete(task, [finding]);
    }, {
      maxConcurrent: 2,
      onProgress: (event) => { if (event.expandedSpec) progress.push(event.expandedSpec); },
      onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    });

    assert.equal(result.status, "completed");
    assert.equal(spawned.length, 3, "two generated children and downstream run; virtual parent does not spawn");
    assert.equal(spawned.some((task) => task.startsWith("Dispatch checks")), false);
    assert.equal(result.nodeStates?.["fanout::api"].status, "completed");
    assert.equal(result.nodeStates?.["fanout::ui"].status, "completed");
    assert.deepEqual(result.finalContext.fanout.findings, ["api-ok", "ui-ok"]);
    assert.match(finalTask, /api-ok/);
    assert.match(finalTask, /ui-ok/);
    assert.ok(progress.some((expanded) => "fanout::api" in expanded.nodes));

    const expansionCheckpoint = checkpoints.find((snapshot) =>
      snapshot.nodeStates["fanout::api"]?.status === "queued"
      && snapshot.nodeStates["fanout::ui"]?.status === "queued");
    assert.ok(expansionCheckpoint, "expanded graph is checkpointed before either child starts");
    assert.deepEqual(expansionCheckpoint.dispatchExpansions.fanout.generatedNodeIds, ["fanout::api", "fanout::ui"]);
    assert.deepEqual(expansionCheckpoint.dispatchExpansions.fanout.sends, spec.nodes.fanout.sends);
    const persisted = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, checkpoints.at(-1)!)));
    assert.equal("version" in persisted ? persisted.version : undefined, 2);
    if ("version" in persisted && persisted.version === 2) {
      assert.ok(persisted.expandedSpec.nodes["fanout::api"]);
      assert.equal(persisted.generatedNodes["fanout::ui"].parentId, "fanout");
    }
  });

  it("counts generated children against the global maxConcurrent limit", async () => {
    const sends = Array.from({ length: 6 }, (_, index) => ({
      key: `child-${index}`,
      role: "coder",
      arg: `child ${index}`,
      expected_output: `result ${index}`,
      consumers: ["$parent"],
    }));
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch bounded work",
        expected_output: "Merged results",
        consumers: ["final"],
        dispatch: { maxChildren: 8 },
        sends,
      },
      final: { task: "finish", depends_on: ["fanout"], expected_output: "Finished result", consumers: ["$result"] },
    } };
    let active = 0;
    let peak = 0;
    const result = await executeDAGCore(spec, async (_role, task) => ({
      agentId: task,
      wait: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active--;
        return { status: "completed" as const, reportPayload: { findings: [task], artifacts: [] } };
      },
    }), { maxConcurrent: 2 });
    assert.equal(result.status, "completed");
    assert.equal(peak, 2);
    assert.equal(result.metrics?.peakConcurrent, 2);
    assert.equal(result.metrics?.dispatchCount, 6);
  });

  it("supports zero-child dispatch without spawning the virtual parent", async () => {
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch optional checks",
        expected_output: "Merged optional results",
        consumers: ["final"],
        dispatch: {},
        sends: [],
      },
      final: { task: "finish empty", depends_on: ["fanout"], expected_output: "Finished result", consumers: ["$result"] },
    } };
    const spawned: string[] = [];
    const result = await executeDAGCore(spec, async (_role, task) => {
      spawned.push(task);
      return complete(task);
    });
    assert.equal(result.status, "completed");
    assert.equal(spawned.length, 1);
    assert.deepEqual(result.finalContext.fanout, { findings: [], artifacts: [] });
  });

  it("preserves a route gate and runs generated children only on the selected branch", async () => {
    const spec: DAGSpec = { nodes: {
      route: {
        task: "choose branch",
        expected_output: "Selected branch",
        consumers: ["fanout", "other"],
        routes: { fanout: ["fanout"], other: ["other"] },
      },
      fanout: {
        task: "Dispatch selected checks",
        depends_on: ["route"],
        expected_output: "Merged selected checks",
        consumers: ["final"],
        dispatch: {},
        sends: [{ key: "one", role: "coder", arg: "selected child", expected_output: "Selected result", consumers: ["$parent"] }],
      },
      other: {
        task: "other branch",
        depends_on: ["route"],
        expected_output: "Other result",
        consumers: ["final"],
      },
      final: {
        task: "finish routed",
        depends_on: ["fanout", "other"],
        expected_output: "Routed result",
        consumers: ["$result"],
      },
    } };
    const spawned: string[] = [];
    const result = await executeDAGCore(spec, async (_role, task) => {
      spawned.push(task);
      const payload: NodePayload = task.startsWith("choose branch")
        ? { findings: ["route"], artifacts: [], route: "fanout" }
        : { findings: [task], artifacts: [] };
      return { agentId: task, wait: async () => ({ status: "completed" as const, reportPayload: payload }) };
    });
    assert.equal(result.status, "completed");
    assert.equal(spawned.some((task) => task.startsWith("selected child")), true);
    assert.equal(spawned.some((task) => task.startsWith("other branch")), false);
    assert.equal(result.nodeStates?.other.status, "skipped");
  });

  it("keeps explicit wave scheduling as a non-deadlocking fallback", async () => {
    const spawned: string[] = [];
    const result = await executeDAGCore(fanoutSpec(), async (_role, task) => {
      spawned.push(task);
      return complete(task);
    }, { scheduler: "wave", maxConcurrent: 2 });
    assert.equal(result.status, "completed");
    assert.equal(result.termination, "all_terminal");
    assert.equal(spawned.length, 3);
  });

  it("fails the virtual parent when a generated child fails and passes that context downstream", async () => {
    let finalTask = "";
    const result = await executeDAGCore(fanoutSpec(), async (_role, task) => {
      if (task.startsWith("check api")) {
        return { agentId: task, wait: async () => ({ status: "failed" as const, error: "api unavailable" }) };
      }
      if (task.startsWith("integrate checks")) finalTask = task;
      return complete(task);
    });
    assert.equal(result.nodeStates?.["fanout::api"].status, "failed");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /fanout::api.*api unavailable/);
    assert.match(finalTask, /Predecessor 'fanout' failed.*fanout::api/s);
  });
});

describe("generated dispatch checkpoint resume", () => {
  it("does not replay a terminal child or dispatch parent and requeues a running child", async () => {
    const declared = fanoutSpec();
    const sends = declared.nodes.fanout.sends!;
    let dispatchCalls = 0;
    const { sends: _sends, ...dynamicParent } = declared.nodes.fanout;
    const original: DAGSpec = { nodes: {
      ...declared.nodes,
      fanout: {
        ...dynamicParent,
        dynamic: async () => {
          dispatchCalls++;
          return sends;
        },
      },
    } };
    const expanded = expandDispatchNode(original, "fanout", sends);
    const snapshot: DAGExecutionSnapshot = {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: {
        fanout: { status: "running" },
        "fanout::api": { status: "completed" },
        "fanout::ui": { status: "running" },
        final: { status: "queued" },
      },
      nodeResults: {
        "fanout::api": { nodeId: "fanout::api", status: "completed", result: { findings: ["api-from-checkpoint"], artifacts: [] } },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::api", "fanout::ui"], source: "dynamic", sends } },
    };
    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(original, snapshot)));
    const spawned: string[] = [];
    let finalTask = "";
    let resumedSnapshot: DAGExecutionSnapshot | undefined;
    const result = await resumeDAG(checkpoint, async (_role, task) => {
      spawned.push(task);
      if (task.startsWith("integrate checks")) finalTask = task;
      return complete(task, task.startsWith("check ui") ? ["ui-after-resume"] : ["done"]);
    }, { onCheckpoint: (next) => { resumedSnapshot = next; } });

    assert.equal(result.status, "completed");
    assert.equal(spawned.some((task) => task.startsWith("check api")), false);
    assert.equal(spawned.some((task) => task.startsWith("Dispatch checks")), false);
    assert.equal(dispatchCalls, 0, "persisted expansion is aggregated without invoking the dispatcher again");
    assert.deepEqual(spawned.map((task) => task.split("\n", 1)[0]), ["check ui", "integrate checks"]);
    assert.match(finalTask, /api-from-checkpoint/);
    assert.match(finalTask, /ui-after-resume/);

    const secondCheckpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(checkpoint.spec, resumedSnapshot!)));
    assert.equal("version" in secondCheckpoint && secondCheckpoint.version === 2
      ? secondCheckpoint.nodeModes.fanout
      : undefined, "dynamic");
    let secondResumeSpawns = 0;
    const secondResume = await resumeDAG(secondCheckpoint, async () => {
      secondResumeSpawns++;
      return complete("unexpected");
    });
    assert.equal(secondResume.status, "completed");
    assert.equal(secondResumeSpawns, 0, "a re-checkpointed dynamic expansion remains resumable without replay");
  });

  it("fails closed when a serialized checkpoint still contains an unresolved dynamic closure", () => {
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "dynamic dispatch",
        dispatch: {},
        dynamic: async () => [],
      },
    } };
    const snapshot: DAGExecutionSnapshot = {
      scheduler: "ready",
      expandedSpec: spec,
      nodeStates: { fanout: { status: "queued" } },
      nodeResults: {},
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    const json = serializeCheckpoint(makeCheckpointV2(spec, snapshot));
    assert.throws(() => deserializeCheckpoint(json), /unresolved dynamic nodes fanout/);
  });

  it("still rejects a queued dynamic closure when the legacy unresolved list is deleted", () => {
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "dynamic dispatch",
        expected_output: "Merged work",
        consumers: ["$result"],
        dispatch: {},
        dynamic: async () => [],
      },
    } };
    const checkpoint = makeCheckpointV2(spec, {
      scheduler: "ready",
      expandedSpec: spec,
      nodeStates: { fanout: { status: "queued" } },
      nodeResults: {},
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    });
    const raw = JSON.parse(serializeCheckpoint(checkpoint));
    delete raw.unresolvedDynamicNodes;
    assert.throws(() => deserializeCheckpoint(JSON.stringify(raw)), /unresolved dynamic node fanout/);
  });

  it("round-trips a completed legacy dynamic node and never reruns it on resume", async () => {
    let dynamicCalls = 0;
    let childSpawns = 0;
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "legacy dynamic dispatch",
        dynamic: async () => {
          dynamicCalls++;
          return [{ role: "coder", arg: "legacy child" }];
        },
      },
    } };
    let terminalSnapshot: DAGExecutionSnapshot | undefined;
    const first = await executeDAGCore(spec, async (_role, task) => {
      childSpawns++;
      return complete(task, ["legacy-complete"]);
    }, { onCheckpoint: (snapshot) => { terminalSnapshot = snapshot; } });
    assert.equal(first.status, "completed");
    assert.equal(dynamicCalls, 1);
    assert.equal(childSpawns, 1);

    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, terminalSnapshot!)));
    let resumeSpawns = 0;
    const resumed = await resumeDAG(checkpoint, async () => {
      resumeSpawns++;
      return complete("unexpected");
    });
    assert.equal(resumed.status, "completed");
    assert.equal(resumeSpawns, 0);
    assert.equal(dynamicCalls, 1);
  });

  it("round-trips a failed explicit dynamic dispatcher and never reruns it on resume", async () => {
    let dynamicCalls = 0;
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "dynamic dispatch that fails",
        expected_output: "Merged optional work",
        consumers: ["$result"],
        dispatch: {},
        dynamic: async () => {
          dynamicCalls++;
          throw new Error("planning failed");
        },
      },
    } };
    let terminalSnapshot: DAGExecutionSnapshot | undefined;
    const first = await executeDAGCore(spec, async () => complete("unexpected"), {
      onCheckpoint: (snapshot) => { terminalSnapshot = snapshot; },
    });
    assert.equal(first.nodeStates?.fanout.status, "failed");
    assert.equal(dynamicCalls, 1);

    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, terminalSnapshot!)));
    let resumeSpawns = 0;
    const resumed = await resumeDAG(checkpoint, async () => {
      resumeSpawns++;
      return complete("unexpected");
    });
    assert.equal(resumed.nodeStates?.fanout.status, "failed");
    assert.equal(resumeSpawns, 0);
    assert.equal(dynamicCalls, 1);
  });

  it("rejects inconsistent generated checkpoint metadata", () => {
    const spec = fanoutSpec();
    const malformed = {
      version: 2,
      spec,
      expandedSpec: spec,
      scheduler: "ready",
      nodeStates: { fanout: { status: "running" }, final: { status: "queued" } },
      nodeModes: { fanout: "sends", final: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::missing"], source: "sends" } },
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /malformed V2 checkpoint/);
  });

  it("rejects a checkpoint whose dispatch is terminal while a child is still running", () => {
    const original = fanoutSpec();
    const expanded = expandDispatchNode(original, "fanout", original.nodes.fanout.sends!);
    const malformed = makeCheckpointV2(original, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: {
        fanout: { status: "completed" },
        "fanout::api": { status: "completed" },
        "fanout::ui": { status: "running" },
        final: { status: "queued" },
      },
      nodeResults: {
        fanout: { nodeId: "fanout", status: "completed", result: { findings: ["premature"], artifacts: [] } },
        "fanout::api": { nodeId: "fanout::api", status: "completed", result: { findings: ["api"], artifacts: [] } },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::api", "fanout::ui"], source: "sends", sends: original.nodes.fanout.sends! } },
    });
    assert.throws(() => deserializeCheckpoint(serializeCheckpoint(malformed)), /terminal dispatch.*non-terminal children/);
  });

  it("rejects a completed dispatch checkpoint with a failed child", () => {
    const original = fanoutSpec();
    const expanded = expandDispatchNode(original, "fanout", original.nodes.fanout.sends!);
    const malformed = makeCheckpointV2(original, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: {
        fanout: { status: "completed" },
        "fanout::api": { status: "completed" },
        "fanout::ui": { status: "failed", error: "ui failed" },
        final: { status: "queued" },
      },
      nodeResults: {
        fanout: { nodeId: "fanout", status: "completed", result: { findings: ["forged"], artifacts: [] } },
        "fanout::api": { nodeId: "fanout::api", status: "completed", result: { findings: ["api"], artifacts: [] } },
        "fanout::ui": { nodeId: "fanout::ui", status: "failed", error: "ui failed" },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::api", "fanout::ui"], source: "sends", sends: original.nodes.fanout.sends! } },
    });
    assert.throws(() => deserializeCheckpoint(serializeCheckpoint(malformed)), /completed dispatch.*non-completed children/);
  });

  it("rejects a completed dispatch checkpoint with a forged aggregate", () => {
    const original = fanoutSpec();
    const expanded = expandDispatchNode(original, "fanout", original.nodes.fanout.sends!);
    const malformed = makeCheckpointV2(original, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: {
        fanout: { status: "completed" },
        "fanout::api": { status: "completed" },
        "fanout::ui": { status: "completed" },
        final: { status: "queued" },
      },
      nodeResults: {
        fanout: { nodeId: "fanout", status: "completed", result: { findings: ["forged"], artifacts: [] } },
        "fanout::api": { nodeId: "fanout::api", status: "completed", result: { findings: ["api"], artifacts: [] } },
        "fanout::ui": { nodeId: "fanout::ui", status: "completed", result: { findings: ["ui"], artifacts: [] } },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::api", "fanout::ui"], source: "sends", sends: original.nodes.fanout.sends! } },
    });
    assert.throws(() => deserializeCheckpoint(serializeCheckpoint(malformed)), /aggregate result does not match/);
  });

  it("rejects a failed dispatch checkpoint when every child completed", () => {
    const original = fanoutSpec();
    const expanded = expandDispatchNode(original, "fanout", original.nodes.fanout.sends!);
    const malformed = makeCheckpointV2(original, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: {
        fanout: { status: "failed", error: "forged failure" },
        "fanout::api": { status: "completed" },
        "fanout::ui": { status: "completed" },
        final: { status: "queued" },
      },
      nodeResults: {
        fanout: { nodeId: "fanout", status: "failed", error: "forged failure" },
        "fanout::api": { nodeId: "fanout::api", status: "completed", result: { findings: ["api"], artifacts: [] } },
        "fanout::ui": { nodeId: "fanout::ui", status: "completed", result: { findings: ["ui"], artifacts: [] } },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: { fanout: { parentId: "fanout", generatedNodeIds: ["fanout::api", "fanout::ui"], source: "sends", sends: original.nodes.fanout.sends! } },
    });
    assert.throws(() => deserializeCheckpoint(serializeCheckpoint(malformed)), /failed dispatch.*only completed children/);
  });

  it("cannot disguise an ordinary node as an expanded zero-child dispatcher", () => {
    const ordinary: DAGSpec = { nodes: { work: { task: "must really run" } } };
    const forged = {
      version: 2,
      spec: ordinary,
      expandedSpec: ordinary,
      scheduler: "ready",
      nodeStates: { work: { status: "running" } },
      nodeModes: { work: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: { work: { parentId: "work", generatedNodeIds: [], source: "dynamic", sends: [] } },
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(forged)), /no original dispatch contract/);
  });

  it("rejects a terminal V2 route decision without its implied skip frontier", () => {
    const routeSpec: DAGSpec = { nodes: {
      decide: { task: "choose", routes: { a: ["a"], b: ["b"] } },
      a: { task: "a", depends_on: ["decide"] },
      b: { task: "b", depends_on: ["decide"] },
    } };
    const malformed = {
      version: 2,
      spec: routeSpec,
      expandedSpec: routeSpec,
      scheduler: "ready",
      nodeStates: {
        decide: { status: "completed", result: { findings: ["a"], artifacts: [], route: "a" } },
        a: { status: "queued" },
        b: { status: "queued" },
      },
      nodeModes: { decide: "spawn", a: "spawn", b: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /skip frontier does not match/);
  });

  it("rejects an extra skip reason that suppresses the selected route", () => {
    const routeSpec: DAGSpec = { nodes: {
      decide: { task: "choose", routes: { a: ["a"], b: ["b"] } },
      a: { task: "a", depends_on: ["decide"] },
      b: { task: "b", depends_on: ["decide"] },
    } };
    const malformed = {
      version: 2,
      spec: routeSpec,
      expandedSpec: routeSpec,
      scheduler: "ready",
      nodeStates: {
        decide: { status: "completed", result: { findings: ["a"], artifacts: [], route: "a" } },
        a: { status: "queued" },
        b: { status: "queued" },
      },
      nodeModes: { decide: "spawn", a: "spawn", b: "spawn" },
      skipReasons: { a: "forged", b: "route 'a' from 'decide' did not select 'b'" },
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /skip frontier does not match/);
  });

  it("rejects an ordinary completed node without a persisted result", () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "produce", expected_output: "Produced value", consumers: ["b"] },
      b: { task: "consume", depends_on: ["a"], expected_output: "Consumed value", consumers: ["$result"] },
    } };
    const malformed = {
      version: 2,
      spec,
      expandedSpec: spec,
      scheduler: "ready",
      nodeStates: { a: { status: "completed" }, b: { status: "queued" } },
      nodeModes: { a: "spawn", b: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /completed node 'a' has no result/);
  });

  it("rejects an expandedSpec that substitutes an ordinary original node", () => {
    const spec: DAGSpec = { nodes: { work: { role: "coder", task: "original work" } } };
    const malformed = {
      version: 2,
      spec,
      expandedSpec: { nodes: { work: { role: "reviewer", task: "substituted work" } } },
      scheduler: "ready",
      nodeStates: { work: { status: "queued" } },
      nodeModes: { work: "spawn" },
      skipReasons: {},
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(malformed)),
      /expandedSpec does not match the mechanically rebuilt topology/,
    );
  });

  it("rejects a substituted dynamic generated child", () => {
    const sends = [{
      key: "probe",
      role: "coder",
      arg: "original child",
      expected_output: "Probe result",
      consumers: ["$parent"],
    }];
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "dispatch probe",
        expected_output: "Merged probe",
        consumers: ["$result"],
        dispatch: {},
        dynamic: async () => sends,
      },
    } };
    const expanded = expandDispatchNode(spec, "fanout", sends);
    const checkpoint = makeCheckpointV2(spec, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: { fanout: { status: "running" }, "fanout::probe": { status: "queued" } },
      nodeResults: {},
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: {
        fanout: { parentId: "fanout", generatedNodeIds: ["fanout::probe"], source: "dynamic", sends },
      },
    });
    const raw = JSON.parse(serializeCheckpoint(checkpoint));
    raw.expandedSpec.nodes["fanout::probe"].role = "reviewer";
    raw.expandedSpec.nodes["fanout::probe"].task = "substituted child";
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(raw)),
      /expandedSpec does not match the mechanically rebuilt topology/,
    );
  });

  it("rejects a completed router carrying an unknown route", () => {
    const spec: DAGSpec = { nodes: {
      decide: { task: "choose", routes: { a: ["a"], b: ["b"] } },
      a: { task: "a", depends_on: ["decide"] },
      b: { task: "b", depends_on: ["decide"] },
    } };
    const malformed = {
      version: 2,
      spec,
      expandedSpec: spec,
      scheduler: "ready",
      nodeStates: {
        decide: { status: "completed", result: { findings: ["bad"], artifacts: [], route: "unknown" } },
        a: { status: "queued" },
        b: { status: "queued" },
      },
      nodeModes: { decide: "spawn", a: "spawn", b: "spawn" },
      skipReasons: { a: "invalid route", b: "invalid route" },
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /completed route node 'decide' has an invalid route/);
  });

  it("rejects a completed node on an unselected route branch", () => {
    const spec: DAGSpec = { nodes: {
      decide: { task: "choose", routes: { a: ["a"], b: ["b"] } },
      a: { task: "a", depends_on: ["decide"] },
      b: { task: "b", depends_on: ["decide"] },
    } };
    const malformed = {
      version: 2,
      spec,
      expandedSpec: spec,
      scheduler: "ready",
      nodeStates: {
        decide: { status: "completed", result: { findings: ["a"], artifacts: [], route: "a" } },
        a: { status: "queued" },
        b: { status: "completed", result: { findings: ["impossible"], artifacts: [] } },
      },
      nodeModes: { decide: "spawn", a: "spawn", b: "spawn" },
      skipReasons: { b: "route 'a' from 'decide' did not select 'b'" },
      generatedNodes: {},
      dispatchExpansions: {},
    };
    assert.throws(() => deserializeCheckpoint(JSON.stringify(malformed)), /route-skipped node 'b' has impossible status 'completed'/);
  });

  it("rejects an expanded dispatch parent in the skipped state", () => {
    const original: DAGSpec = { nodes: {
      fanout: {
        task: "dispatch",
        expected_output: "Merged result",
        consumers: ["$result"],
        dispatch: {},
        sends: [{ key: "child", role: "coder", arg: "child", expected_output: "Child result", consumers: ["$parent"] }],
      },
    } };
    const sends = original.nodes.fanout.sends!;
    const expanded = expandDispatchNode(original, "fanout", sends);
    const malformed = makeCheckpointV2(original, {
      scheduler: "ready",
      expandedSpec: expanded.spec,
      nodeStates: { fanout: { status: "skipped", error: "impossible" }, "fanout::child": { status: "completed" } },
      nodeResults: {
        "fanout::child": { nodeId: "fanout::child", status: "completed", result: { findings: ["done"], artifacts: [] } },
      },
      skipReasons: {},
      generatedNodes: expanded.generatedNodes,
      dispatchExpansions: {
        fanout: { parentId: "fanout", generatedNodeIds: ["fanout::child"], source: "sends", sends },
      },
    });
    assert.throws(() => deserializeCheckpoint(serializeCheckpoint(malformed)), /expanded dispatch 'fanout' cannot be skipped/);
  });

  it("round-trips two sequential dispatch expansions without rejecting consumer rewrites", async () => {
    const spec: DAGSpec = { nodes: {
      a: {
        task: "dispatch a",
        expected_output: "A aggregate",
        consumers: ["b"],
        dispatch: {},
        sends: [{ key: "ca", role: "coder", arg: "child a", expected_output: "A child", consumers: ["$parent"] }],
      },
      b: {
        task: "dispatch b",
        depends_on: ["a"],
        expected_output: "B aggregate",
        consumers: ["final"],
        dispatch: {},
        sends: [{ key: "cb", role: "reviewer", arg: "child b", expected_output: "B child", consumers: ["$parent"] }],
      },
      final: {
        task: "finish",
        depends_on: ["b"],
        expected_output: "Final result",
        consumers: ["$result"],
      },
    } };
    let terminalSnapshot: DAGExecutionSnapshot | undefined;
    const first = await executeDAGCore(spec, async (_role, task) => complete(task), {
      onCheckpoint: (snapshot) => { terminalSnapshot = snapshot; },
    });
    assert.equal(first.status, "completed");
    const checkpoint = deserializeCheckpoint(serializeCheckpoint(makeCheckpointV2(spec, terminalSnapshot!)));
    let resumeSpawns = 0;
    const resumed = await resumeDAG(checkpoint, async () => {
      resumeSpawns++;
      return complete("unexpected");
    });
    assert.equal(resumed.status, "completed");
    assert.equal(resumeSpawns, 0);
  });
});

describe("DAG abort termination", () => {
  it("reports aborted when a signal interrupts the only running node", async () => {
    const controller = new AbortController();
    const spawnFn: SpawnFn = async () => ({
      agentId: "only",
      wait: () => new Promise(() => {}),
    });
    queueMicrotask(() => controller.abort());
    const result = await executeDAGCore({ nodes: { only: { task: "only" } } }, spawnFn, { signal: controller.signal });
    assert.equal(result.termination, "aborted");
    assert.notEqual(result.status, "completed");
  });
});
