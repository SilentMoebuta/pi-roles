import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toDagProgress, makeOnProgress } from "../src/dag/progress";
import type { DAGSpec } from "../src/dag/types";

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
  });
  it("nodes without explicit status default to 'queued'", () => {
    const raw = { currentWave: 0, totalWaves: 1, nodes: {} };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].status, "queued");
  });
  it("computes wave assignment via topological layering (Kahn)", () => {
    const raw = { currentWave: 0, totalWaves: 2, nodes: {} };
    const view = toDagProgress(spec, raw);
    assert.equal(view.nodes["task-1"].wave, 0);
    assert.equal(view.nodes["task-2"].wave, 0);
    assert.equal(view.nodes["task-3"].wave, 1);
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
  it("still emits a human-readable text content line", () => {
    const captured: any[] = [];
    makeOnProgress(spec, (r) => captured.push(r))({ currentWave: 1, totalWaves: 3, nodes: {} });
    assert.match(captured[0].content[0].text, /wave 2\/3/);
  });
});
