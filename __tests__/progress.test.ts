import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toDagProgress, makeOnProgress } from "../src/dag/progress";
import { executeDAGCore } from "../src/dag/executor";
import type { DAGProgress, DAGSpec } from "../src/dag/types";

const spec: DAGSpec = {
  nodes: {
    "task-1": { task: "do A", depends_on: [] },
    "task-2": { task: "do B", depends_on: [] },
    "task-3": { task: "do C after A", depends_on: ["task-1"] },
  },
};

describe("toDagProgress", () => {
  it("maps raw progress + spec to a structured view with topology + node states", () => {
    const raw = { currentWave: 1, totalWaves: 2, nodes: {
      "task-1": { status: "completed" },
      "task-2": { status: "running" },
      "task-3": { status: "queued" },
    } };
    const view = toDagProgress(spec, raw);
    assert.equal(view.currentWave, 1);
    assert.equal(view.totalWaves, 2);
    assert.deepEqual(view.nodes["task-3"].deps, ["task-1"]);
    assert.equal(view.nodes["task-1"].status, "completed");
    assert.equal(view.nodes["task-2"].status, "running");
    assert.equal(view.nodes["task-3"].status, "queued");
    assert.deepEqual(view.frontier.running, ["task-2"]);
    assert.deepEqual(view.frontier.ready, ["task-3"]);
    assert.deepEqual(view.frontier.settled, ["task-1"]);
  });
  it("nodes without explicit status default to 'queued' (for current/future waves)", () => {
    const raw = { currentWave: 0, totalWaves: 1, nodes: {} };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].status, "queued");
  });
  it("nodes in COMPLETED waves (wave < currentWave) without explicit status default to 'completed'", () => {
    // Real bug from actual DAG run: executor's onProgress only reports the
    // CURRENT wave's nodes, so nodes from earlier (completed) waves are absent
    // from raw.nodes. They were shown as 'queued' (○) even though done —
    // making the widget lie (Wave 0 showed 0/3 while currentWave had advanced).
    const raw = { currentWave: 1, totalWaves: 2, nodes: {
      "task-3": { status: "queued" }, // task-3 is in wave 1, current → queued
      // task-1, task-2 (wave 0, < currentWave 1) ABSENT from raw — should infer completed
    } };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].status, "completed", "wave-0 node absent from raw but wave < currentWave → completed");
    assert.equal(view.nodes["task-2"].status, "completed", "wave-0 node absent from raw but wave < currentWave → completed");
    assert.equal(view.nodes["task-3"].status, "queued", "current-wave node keeps its explicit queued status");
  });
  it("explicit-state updates never infer an omitted earlier-wave node as completed", () => {
    const raw = { currentWave: 1, totalWaves: 2, explicitStates: true, nodes: {
      "task-3": { status: "running" },
    } };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].status, "queued");
    assert.equal(view.nodes["task-2"].status, "queued");
  });
  it("computes wave assignment via topological layering (Kahn)", () => {
    const raw = { currentWave: 0, totalWaves: 2, nodes: {} };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].wave, 0);
    assert.equal(view.nodes["task-2"].wave, 0);
    assert.equal(view.nodes["task-3"].wave, 1);
  });

  it("retains wave compatibility fields alongside the frontier projection", () => {
    const view = toDagProgress(spec, { currentWave: 1, totalWaves: 4, nodes: {} }, "compat");
    assert.equal(view.dagId, "compat");
    assert.equal(view.currentWave, 1);
    assert.equal(view.totalWaves, 4);
    assert.equal(view.nodes["task-3"].wave, 1);
    assert.ok(Array.isArray(view.frontier.settled));
  });

  it("preserves route metadata from raw progress", () => {
    const raw = { currentWave: 0, totalWaves: 2, nodes: {
      "task-1": { status: "completed", route: "accept" },
    } };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].route, "accept");
    assert.deepEqual(view.routeDecisions, { "task-1": "accept" });
  });

  it("separates ready work from queued work blocked by dependencies", () => {
    const view = toDagProgress(spec, {
      currentWave: 0,
      totalWaves: 2,
      explicitStates: true,
      nodes: {
        "task-1": { status: "running" },
        "task-2": { status: "queued" },
        "task-3": { status: "queued" },
      },
    });
    assert.deepEqual(view.frontier.ready, ["task-2"]);
    assert.deepEqual(view.frontier.blocked, ["task-3"]);
    assert.deepEqual(view.nodes["task-3"].waitingOn, ["task-1"]);
  });

  it("treats the legacy wave barrier as blocked scheduler work", () => {
    const view = toDagProgress(spec, {
      currentWave: 0,
      totalWaves: 2,
      scheduler: "wave",
      explicitStates: true,
      nodes: {
        "task-1": { status: "completed" },
        "task-2": { status: "running" },
        "task-3": { status: "queued" },
      },
    });
    assert.deepEqual(view.frontier.ready, []);
    assert.deepEqual(view.frontier.blocked, ["task-3"]);
    assert.equal(view.nodes["task-3"].blockReason, "wave_barrier");
  });

  it("identifies the deepest active structural path used by ready scheduling", () => {
    const deepSpec: DAGSpec = { nodes: {
      deep: { task: "deep" },
      middle: { task: "middle", depends_on: ["deep"] },
      leaf: { task: "leaf", depends_on: ["middle"] },
      shallow: { task: "shallow" },
    } };
    const view = toDagProgress(deepSpec, {
      currentWave: 0,
      totalWaves: 3,
      explicitStates: true,
      nodes: {
        deep: { status: "queued" },
        middle: { status: "queued" },
        leaf: { status: "queued" },
        shallow: { status: "queued" },
      },
    });
    assert.equal(view.nodes.deep.remainingPath, 3);
    assert.deepEqual(view.frontier.critical, ["deep"]);
  });

  it("distinguishes terminal completed, partial, and failed outcomes from settled state", () => {
    const terminalSpec: DAGSpec = { nodes: {
      ok: { task: "ok" },
      bad: { task: "bad" },
    } };
    const completed = toDagProgress(terminalSpec, {
      currentWave: 0, totalWaves: 1, explicitStates: true,
      nodes: { ok: { status: "completed" }, bad: { status: "skipped" } },
    });
    const partial = toDagProgress(terminalSpec, {
      currentWave: 0, totalWaves: 1, explicitStates: true,
      nodes: { ok: { status: "completed" }, bad: { status: "failed", error: "boom" } },
    });
    const failed = toDagProgress(terminalSpec, {
      currentWave: 0, totalWaves: 1, explicitStates: true,
      nodes: { ok: { status: "failed" }, bad: { status: "failed" } },
    });
    assert.equal(completed.outcome, "completed");
    assert.equal(partial.outcome, "partial");
    assert.deepEqual(partial.frontier.failed, ["bad"]);
    assert.equal(failed.outcome, "failed");
  });
});

describe("makeOnProgress", () => {
  it("forwards structured details (NOT undefined) with kind dag-progress", () => {
    const captured: any[] = [];
    const fn = makeOnProgress(spec, (r) => captured.push(r));
    fn({ currentWave: 0, totalWaves: 1, nodes: { "task-1": { status: "running" } } });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].details.kind, "dag-progress");
    assert.equal(captured[0].details.progress.nodes["task-1"].status, "running");
    assert.notEqual(captured[0].details, undefined, "details must NOT be undefined (regression: was undefined before fix)");
  });
  it("emits a human-readable frontier summary instead of wave-shaped progress", () => {
    const captured: any[] = [];
    makeOnProgress(spec, (r) => captured.push(r))({ currentWave: 1, totalWaves: 3, nodes: {} });
    assert.match(captured[0].content[0].text, /DAG frontier:/);
    assert.match(captured[0].content[0].text, /settled/);
    assert.doesNotMatch(captured[0].content[0].text, /wave/i);
  });
  it("projects scheduler-generated nodes from the expanded progress spec", () => {
    const captured: any[] = [];
    const expanded: DAGSpec = { nodes: {
      ...spec.nodes,
      "task-1::generated": { task: "generated work" },
    } };
    makeOnProgress(spec, (r) => captured.push(r))({
      currentWave: 0,
      totalWaves: 2,
      explicitStates: true,
      expandedSpec: expanded,
      generatedNodes: {
        "task-1::generated": { id: "task-1::generated", key: "generated", parentId: "task-1" },
      },
      nodes: {
        "task-1": { status: "running" },
        "task-2": { status: "queued" },
        "task-3": { status: "queued" },
        "task-1::generated": { status: "queued" },
      },
    });
    assert.ok(captured[0].details.spec.nodes["task-1::generated"]);
    assert.equal(captured[0].details.progress.nodes["task-1::generated"].status, "queued");
    assert.equal(captured[0].details.progress.nodes["task-1::generated"].generatedFrom, "task-1");
    assert.equal(captured[0].details.progress.generatedNodes["task-1::generated"].key, "generated");
  });

  it("keeps a terminal partial outcome and failure count visible in stream text", () => {
    const captured: any[] = [];
    makeOnProgress(spec, (result) => captured.push(result))({
      currentWave: 1,
      totalWaves: 2,
      scheduler: "ready",
      explicitStates: true,
      outcome: "partial",
      termination: "all_terminal",
      nodes: {
        "task-1": { status: "completed" },
        "task-2": { status: "failed", error: "boom" },
        "task-3": { status: "completed" },
      },
    });
    assert.match(captured[0].content[0].text, /outcome=partial/);
    assert.match(captured[0].content[0].text, /failed=1/);
    assert.equal(captured[0].details.progress.termination, "all_terminal");
  });
});

describe("executor progress wave compatibility", () => {
  it("reports the actual running root wave instead of the queued successor wave", async () => {
    const events: Array<{ currentWave: number; nodes: Record<string, { status: string }> }> = [];
    await executeDAGCore({ nodes: {
      root: { task: "root" },
      child: { task: "child", depends_on: ["root"] },
    } }, async (_role, task) => ({
      agentId: task,
      wait: async () => ({ status: "completed", reportPayload: { findings: [task], artifacts: [] } }),
    }), { onProgress: (event) => events.push(event) });
    const rootRunning = events.find((event) => event.nodes.root.status === "running");
    assert.ok(rootRunning);
    assert.equal(rootRunning.currentWave, 0);
  });

  it("emits exact partial/all_terminal metadata on the final progress event", async () => {
    const events: DAGProgress[] = [];
    const result = await executeDAGCore({ nodes: {
      ok: { task: "ok" },
      bad: { task: "bad" },
    } }, async (_role, task) => ({
      agentId: task,
      wait: async () => task === "bad"
        ? { status: "failed" as const, error: "boom" }
        : { status: "completed" as const, reportPayload: { findings: [task], artifacts: [] } },
    }), { onProgress: (event) => events.push(event) });
    const final = events.at(-1)!;
    assert.equal(result.status, "partial");
    assert.equal(result.termination, "all_terminal");
    assert.equal(final.outcome, "partial");
    assert.equal(final.termination, "all_terminal");
    assert.equal(final.nodes.bad.status, "failed");
  });
});
