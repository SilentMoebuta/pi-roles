import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDagGraph, STATUS_SYMBOL, displayWidth } from "../src/dag/dag-graph";
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
    // display-width aware: ASCII counts as 1 col
    assert.ok(lines.every(l => displayWidth(l) <= 40), "no line exceeds display width");
  });
  it("CJK width: Chinese chars count as 2 display columns, not 1 (prevents TUI wrapping)", () => {
    // A node with a long Chinese task must be truncated by DISPLAY width,
    // not code-point length — otherwise 40 Chinese chars = 80 code points
    // would pass a length<=80 check but render as 80 display cols in a 40-col
    // widget, forcing the TUI to wrap (the real-world bug).
    const longChinese = "调研 2026 上半年中国大陆主要经济作物的经济回报价格走势亩均收益".repeat(2);
    const v = view({ nodes: { "task-1": { task: longChinese, deps: [], status: "queued", wave: 0 } } });
    const lines = renderDagGraph(v, 40);
    const nodeLine = lines.find(l => l.includes("task-1"))!;
    assert.ok(displayWidth(nodeLine) <= 40, `node line display width ${displayWidth(nodeLine)} must be <= 40 (CJK=2)`);
  });
  it("node line shows a SHORT label, not the full multi-sentence task text", () => {
    const longTask = "调研 2026 上半年中国大陆主要经济作物（粮油棉糖等大宗类）的经济回报：价格走势、亩均收益、成本结构、种植面积变化、政策补贴。输出结构化 findings";
    const v = view({ nodes: { "task-1": { task: longTask, deps: [], status: "queued", wave: 0 } } });
    const lines = renderDagGraph(v, 80);
    const nodeLine = lines.find(l => l.includes("task-1"))!;
    // the full long task must NOT appear verbatim on the node line
    assert.ok(!nodeLine.includes("输出结构化"), "full task tail must not appear on node line");
    // line should be short enough to be a readable overview
    assert.ok(displayWidth(nodeLine) <= 80, "node line stays within width");
  });
  it("shows header with wave progress (currentWave/totalWaves)", () => {
    const v = view({ currentWave: 1, totalWaves: 3 });
    const joined = renderDagGraph(v, 60).join("\n");
    assert.match(joined, /1.*3/);
  });
  it("renders dependency edges as ASCII box-line connectors (├─ └─), not text annotation", () => {
    const v: DagProgressView = {
      dagId: "d1", currentWave: 1, totalWaves: 2,
      nodes: {
        "task-1": { task: "A", deps: [], status: "completed", wave: 0 },
        "task-2": { task: "B", deps: [], status: "completed", wave: 0 },
        "task-3": { task: "C after A+B", deps: ["task-1", "task-2"], status: "running", wave: 1 },
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

  describe("dynamic expand/collapse by wave state", () => {
    // Multi-wave view: wave 0 done, wave 1 running, wave 2 not started.
    function multiWaveView(): DagProgressView {
      return {
        dagId: "d1", currentWave: 1, totalWaves: 3,
        nodes: {
          "task-1": { task: "research A", deps: [], status: "completed", wave: 0 },
          "task-2": { task: "research B", deps: [], status: "completed", wave: 0 },
          "task-3": { task: "consolidate", deps: ["task-1", "task-2"], status: "running", wave: 1 },
          "task-4": { task: "deep dive A", deps: ["task-3"], status: "queued", wave: 2 },
          "task-5": { task: "deep dive B", deps: ["task-3"], status: "queued", wave: 2 },
        },
      };
    }
    it("collapses a fully-completed wave into a one-line summary (no node details)", () => {
      const lines = renderDagGraph(multiWaveView(), 70);
      // wave 0 is done → collapsed: header line present, node lines absent
      const w0Header = lines.find(l => /Wave 0/.test(l));
      assert.ok(w0Header, "Wave 0 header present");
      // no "task-1: research A" node line under wave 0 (collapsed)
      const w0Block = lines.slice(lines.indexOf(w0Header!) + 1, lines.findIndex((l, i) => i > lines.indexOf(w0Header!) && /Wave \d/.test(l)));
      assert.ok(!w0Block.some(l => /task-1:/.test(l) || /task-2:/.test(l)), "completed wave 0 nodes collapsed (no node detail lines)");
      // summary should show done count
      assert.match(w0Header!, /2\/2|✓/ , "collapsed wave shows completion");
    });
    it("expands the running wave with full node + dep detail", () => {
      const lines = renderDagGraph(multiWaveView(), 70);
      // wave 1 is running → expanded: task-3 node line + its dep connectors present
      assert.ok(lines.some(l => /task-3/.test(l) && /:/.test(l)), "running wave node line shown");
      assert.ok(lines.some(l => /[├└]─.*task-1/.test(l)), "running wave dep edges shown");
    });
    it("collapses a not-yet-started wave into a one-line summary", () => {
      const lines = renderDagGraph(multiWaveView(), 70);
      const w2Header = lines.find(l => /Wave 2/.test(l));
      assert.ok(w2Header, "Wave 2 header present");
      // no task-4/task-5 node detail lines
      const w2Block = lines.slice(lines.indexOf(w2Header!) + 1);
      assert.ok(!w2Block.some(l => /task-4:/.test(l) || /task-5:/.test(l)), "queued wave 2 nodes collapsed");
      assert.match(w2Header!, /0\/2|queued|○/, "collapsed wave shows queued state");
    });
    it("keeps total output short (collapsed waves don't bloat the widget)", () => {
      const lines = renderDagGraph(multiWaveView(), 70);
      // 3 wave headers + running wave's ~4 detail lines + header ≈ < 12 lines
      assert.ok(lines.length <= 12, `output has ${lines.length} lines, should be compact (<=12)`);
    });
    it("still shows header with wave progress", () => {
      const lines = renderDagGraph(multiWaveView(), 70);
      assert.ok(lines.some(l => /wave 2\/3/.test(l)), "header shows current wave progress");
    });
  });
});
