import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderDagGraph, STATUS_SYMBOL, displayWidth } from "../src/dag/dag-graph";
import { toDagProgress } from "../src/dag/progress";
import type { DAGProgress, DAGSpec } from "../src/dag/types";

function view(
  spec: DAGSpec,
  nodes: DAGProgress["nodes"],
  extra: Partial<DAGProgress> = {},
) {
  return toDagProgress(spec, {
    currentWave: 0,
    totalWaves: 1,
    scheduler: "ready",
    explicitStates: true,
    nodes,
    ...extra,
  }, "d1");
}

describe("renderDagGraph frontier view", () => {
  it("shows a dependency-free queued node as ready work", () => {
    const spec: DAGSpec = { nodes: { root: { task: "start here" } } };
    const joined = renderDagGraph(view(spec, { root: { status: "queued" } }), 80).join("\n");
    assert.match(joined, /Ready \(1\)[\s\S]*○ root/);
    assert.doesNotMatch(joined, /Blocked \/ waiting/);
  });

  it("uses scheduler frontier categories as the primary display", () => {
    const spec: DAGSpec = { nodes: {
      slow: { task: "slow independent work" },
      root: { task: "root", priority: 2 },
      child: { task: "child", depends_on: ["root"] },
      done: { task: "already done" },
    } };
    const lines = renderDagGraph(view(spec, {
      slow: { status: "running" },
      root: { status: "queued" },
      child: { status: "queued" },
      done: { status: "completed" },
    }), 100);
    const joined = lines.join("\n");
    assert.match(joined, /frontier · ready scheduler/);
    assert.match(joined, /Running 1 · Ready 1 · Blocked 1 · Settled 1\/4/);
    assert.match(joined, /Running \(1\)[\s\S]*slow/);
    assert.match(joined, /Ready \(1\)[\s\S]*root/);
    assert.match(joined, /Blocked \/ waiting \(1\)[\s\S]*child.*wait=root/);
    assert.doesNotMatch(joined, /Wave \d/);
  });

  it("shows failures, route decisions, and generated-node provenance", () => {
    const spec: DAGSpec = { nodes: {
      decide: { task: "choose route" },
      fanout: { task: "fan out" },
      "fanout::api": { task: "inspect api", depends_on: ["fanout"] },
      failed: { task: "verify", role: "reviewer" },
    } };
    const joined = renderDagGraph(view(spec, {
      decide: { status: "completed", route: "accept" },
      fanout: { status: "running" },
      "fanout::api": { status: "running" },
      failed: { status: "failed", error: "verification conflict" },
    }, {
      generatedNodes: {
        "fanout::api": { id: "fanout::api", key: "api", parentId: "fanout" },
      },
    }), 120).join("\n");
    assert.match(joined, /Failed \(1\)[\s\S]*verification confli/);
    assert.match(joined, /Routes  decide=accept/);
    assert.match(joined, /Generated 1 from fanout/);
    assert.match(joined, /fanout::api.*from=fanout/);
    assert.ok(joined.includes(STATUS_SYMBOL.failed));
  });

  it("labels structural critical-frontier depth without presenting a percentage", () => {
    const spec: DAGSpec = { nodes: {
      long: { task: "long root" },
      middle: { task: "middle", depends_on: ["long"] },
      leaf: { task: "leaf", depends_on: ["middle"] },
      short: { task: "short root" },
    } };
    const progress = view(spec, {
      long: { status: "queued" },
      middle: { status: "queued" },
      leaf: { status: "queued" },
      short: { status: "queued" },
    });
    assert.deepEqual(progress.frontier.critical, ["long"]);
    const joined = renderDagGraph(progress, 100).join("\n");
    assert.match(joined, /long:.*path=3/);
    assert.doesNotMatch(joined, /%/);
  });

  it("shows role and non-zero priority for scheduler inspection", () => {
    const spec: DAGSpec = { nodes: {
      review: { task: "review result", role: "reviewer", priority: 7 },
    } };
    const joined = renderDagGraph(view(spec, { review: { status: "running" } }), 100).join("\n");
    assert.match(joined, /review:.*p=7.*role=reviewer/);
  });

  it("bounds every line by terminal display width, including CJK", () => {
    const longChinese = "调研中国大陆主要经济作物的价格走势亩均收益成本结构种植面积变化政策补贴".repeat(2);
    const spec: DAGSpec = { nodes: Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`task-${index}`, { task: `${longChinese}${index}` }]),
    ) };
    const nodes = Object.fromEntries(Object.keys(spec.nodes).map((id) => [id, { status: "queued" as const }]));
    const lines = renderDagGraph(view(spec, nodes), 40);
    assert.ok(lines.every((line) => displayWidth(line) <= 40));
    assert.match(lines.join("\n"), /\+4 more/);
  });

  it("uses a short activity label instead of rendering a full task brief", () => {
    const task = "Research the API contract, migration behavior, compatibility risks, failure modes, and integration evidence in detail";
    const spec: DAGSpec = { nodes: { research: { task } } };
    const joined = renderDagGraph(view(spec, { research: { status: "running" } }), 120).join("\n");
    assert.match(joined, /Research the API contra/);
    assert.doesNotMatch(joined, /integration evidence/);
  });

  it("labels a legacy progress producer as wave-scheduled without restoring wave-primary UI", () => {
    const spec: DAGSpec = { nodes: { root: { task: "legacy root" } } };
    const legacy = toDagProgress(spec, { currentWave: 0, totalWaves: 1, nodes: { root: { status: "running" } } });
    const joined = renderDagGraph(legacy, 80).join("\n");
    assert.match(joined, /frontier · wave scheduler/);
    assert.doesNotMatch(joined, /Wave 0|wave 1\/1/);
  });

  it("keeps terminal success compact while retaining settled state counts", () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "A" },
      b: { task: "B" },
      c: { task: "C" },
    } };
    const lines = renderDagGraph(view(spec, {
      a: { status: "completed" },
      b: { status: "skipped" },
      c: { status: "completed" },
    }), 80);
    assert.ok(lines.length <= 3);
    assert.match(lines.join("\n"), /Settled 3\/3/);
    assert.match(lines.join("\n"), /✓2 ·1 ✗0/);
  });

  it("prominently distinguishes a terminal partial outcome from mere settlement", () => {
    const spec: DAGSpec = { nodes: {
      ok: { task: "completed work" },
      bad: { task: "failed verification" },
    } };
    const lines = renderDagGraph(view(spec, {
      ok: { status: "completed" },
      bad: { status: "failed", error: "evidence conflict" },
    }, { outcome: "partial", termination: "all_terminal" }), 100);
    assert.match(lines[0], /PARTIAL/);
    assert.match(lines[1], /^FAILED 1 ·/);
    assert.ok(lines.findIndex((line) => /^Failed \(1\)/.test(line)) < lines.findIndex((line) => /^Settled  /.test(line)));
    assert.match(lines.join("\n"), /bad:.*evidence conflict/);
  });
});
