import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDagGraph, STATUS_SYMBOL } from "../src/dag/dag-graph";
import type { DagProgressView } from "../src/dag/progress";

function view(overrides: Partial<DagProgressView> = {}): DagProgressView {
  return {
    dagId: "d1", currentWave: 0, totalWaves: 1,
    nodes: { "task-1": { task: "do A", deps: [], status: "queued", wave: 0 } },
    ...overrides,
  };
}

describe("renderDagGraph", () => {
  it("renders a single node with its name and status symbol", () => {
    const lines = renderDagGraph(view(), 40);
    const joined = lines.join("\n");
    assert.match(joined, /task-1/);
    assert.ok(lines.some(l => l.includes(STATUS_SYMBOL.queued)), "queued symbol present");
  });
  it("groups nodes by wave (each wave on its own line/block)", () => {
    const v = view({ totalWaves: 2, currentWave: 1, nodes: {
      "task-1": { task: "A", deps: [], status: "completed", wave: 0 },
      "task-2": { task: "B", deps: [], status: "completed", wave: 0 },
      "task-3": { task: "C", deps: ["task-1"], status: "running", wave: 1 },
    }});
    const lines = renderDagGraph(v, 60);
    const joined = lines.join("\n");
    assert.match(joined, /Wave 0/);
    assert.match(joined, /Wave 1/);
    assert.ok(joined.indexOf("Wave 0") < joined.indexOf("Wave 1"), "wave 0 before wave 1");
  });
  it("shows completed symbol for completed node, running for running", () => {
    const v = view({ nodes: {
      "task-1": { task: "A", deps: [], status: "completed", wave: 0 },
      "task-2": { task: "B", deps: [], status: "running", wave: 0 },
      "task-3": { task: "C", deps: [], status: "failed", wave: 0 },
    }});
    const joined = renderDagGraph(v, 80).join("\n");
    assert.ok(joined.includes(STATUS_SYMBOL.completed));
    assert.ok(joined.includes(STATUS_SYMBOL.running));
    assert.ok(joined.includes(STATUS_SYMBOL.failed));
  });
  it("shows error text for a failed node", () => {
    const v = view({ nodes: {
      "task-1": { task: "A", deps: [], status: "failed", wave: 0, error: "boom" },
    }});
    const joined = renderDagGraph(v, 80).join("\n");
    assert.match(joined, /boom/);
  });
  it("respects width — truncates long node lists rather than overflowing", () => {
    const v = view({ nodes: Object.fromEntries(
      Array.from({length: 10}, (_, i) => [`task-${i}`, { task: `task ${i}`.repeat(5), deps: [], status: "queued", wave: 0 }])
    )});
    const lines = renderDagGraph(v, 40);
    assert.ok(lines.every(l => l.length <= 40), "no line exceeds width");
  });
  it("shows header with wave progress (currentWave/totalWaves)", () => {
    const v = view({ currentWave: 1, totalWaves: 3 });
    const joined = renderDagGraph(v, 60).join("\n");
    assert.match(joined, /1.*3/);
  });
  it("renders dependency edges as ASCII box-line connectors (├─ └─), not text annotation", () => {
    const v: DagProgressView = {
      dagId: "d1", currentWave: 0, totalWaves: 2,
      nodes: {
        "task-1": { task: "A", deps: [], status: "completed", wave: 0 },
        "task-2": { task: "B", deps: [], status: "completed", wave: 0 },
        "task-3": { task: "C after A+B", deps: ["task-1", "task-2"], status: "queued", wave: 1 },
      },
    };
    const lines = renderDagGraph(v, 80);
    const joined = lines.join("\n");
    // dep edges rendered with box-line connectors (├─ or └─), not text [deps:]
    assert.ok(/[├└]─/.test(joined), "box-line connector present (├─ or └─)");
    // the node line itself must NOT carry an inline [deps:] text annotation
    const t3Line = lines.find(l => l.includes("task-3") && l.includes(":"))!;
    assert.doesNotMatch(t3Line, /\[deps/, "no inline [deps:] text annotation on node line");
    // each dependency appears on its own connector line, prefixed by a box char
    assert.ok(lines.some(l => /[├└]─.*task-1/.test(l)), "task-1 dep on a connector line");
    assert.ok(lines.some(l => /[├└]─.*task-2/.test(l)), "task-2 dep on a connector line");
    // multi-dep: first dep uses ├─ (branch), last uses └─ (terminator)
    assert.ok(lines.some(l => l.includes("├─") && /task-1/.test(l)), "first dep branches with ├─");
    assert.ok(lines.some(l => l.includes("└─") && /task-2/.test(l)), "last dep terminates with └─");
  });
});
