# pi-roles DAG 可见性实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 pi-roles 执行 DAG 时，让 pi 的 TUI 渲染一个 DAG 状态图（节点标状态 + wave 分层 + 依赖边），使 pi 自己的用户能看见编排进度。

**Architecture:** pi-roles 已有完整图数据（DAGSpec.nodes + depends_on 边、planWaves 拓扑分层、executeDAGCore 维护 nodeResults 状态、onProgress 回调已暴露 DAGProgress）。唯一缺口是 `dag-execute-tool.ts:170` 把结构化 progress 降级成一行文本 + `details: undefined`。透传链路已验证通（agent-session.js:419-428 原样 emit partialResult 到主会话 EventBus，主会话 extension 可订阅 tool_execution_update）。修复 = 补 1 行桥接 + 新增 1 个 dag-visibility extension（订阅事件、渲染 ASCII 图到 widget）。纯只读，不碰 pi-core、不碰子 session 边界。

**Tech Stack:** TypeScript, pi ExtensionAPI (tool_execution_update 订阅 + ctx.ui.setWidget), tsx --test TDD, ASCII 框线图。无新依赖。

**Spec:** `docs/research/2026-06-24-pi-roles-dag-visibility-internal.md`（researcher 技术调研，未决项已澄清）

**Scope discipline:** 不改 pi-coding-agent（pi-core）；不改 pi-roles 的 spawn.ts / 子 session EventBus 隔离；纯只读可见，不做操控/干预；不并入 pi-a2ui。

---

## File Structure

### `pi-roles/src/dag/` (MODIFY — 补桥接)
- `dag-execute-tool.ts` (MODIFY) — onProgress 回调把 details 从 undefined 改成结构化 `{kind:'dag-progress', spec, progress: p}`。
- `progress.ts` (NEW) — 纯函数 `toDagProgress(spec, p)`：把 executor 的 raw progress + spec 映射成结构化 DagProgressView（带拓扑、节点状态）。纯、可单测。
- `__tests__/progress.test.ts` (NEW) — TDD toDagProgress。

### `pi-roles/src/dag/dag-graph.ts` (NEW — 纯渲染算法)
- `renderDagGraph(view: DagProgressView, width: number): string[]` — 纯函数，把 DAG 视图渲染成 ASCII 框线图行数组（wave 分层、节点带状态符号、依赖边）。无 TUI 依赖，纯字符串，可单测。
- `__tests__/dag-graph.test.ts` (NEW) — TDD renderDagGraph（各种 DAG 形态、状态组合、宽度截断）。

### `pi-roles/src/dag/dag-visibility.ts` (NEW — extension 接线)
- extension 默认导出：`pi.on('tool_execution_update')` 过滤 dag_execute → 读 args.spec + partialResult.details.progress → toDagProgress → renderDagGraph → `ctx.ui.setWidget('dag-visibility', lines)`。tool_execution_end/session_start 清理 widget。并发按 toolCallId 键化。
- `__tests__/dag-visibility.test.ts` (NEW) — TDD 接线逻辑（过滤、键化、清理），用 fake pi 事件。

### `pi-roles/index.ts` (MODIFY — 注册新 extension)
- import 并加载 dag-visibility extension（现有 index.ts 已是 extension 入口，加一行加载）。

### `pi-roles/scripts/dag-visibility-smoke.md` (NEW — runbook)
- 手动 E2E 步骤：触发 dag_execute、在 TUI 看到 DAG 图、预期现象。

---

## Tasks

### Task 1: 纯函数 toDagProgress (TDD)
**Role:** coder | **Deps:** []

**Files:**
- Create: `src/dag/progress.ts`
- Test: `__tests__/progress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toDagProgress } from "../src/dag/progress";
import type { DAGSpec } from "../src/dag/types";

describe("toDagProgress", () => {
  const spec: DAGSpec = {
    nodes: {
      "task-1": { task: "do A", depends_on: [] },
      "task-2": { task: "do B", depends_on: [] },
      "task-3": { task: "do C after A", depends_on: ["task-1"] },
    },
  };
  it("maps raw progress + spec to a structured view with topology + node states", () => {
    const raw = { currentWave: 1, totalWaves: 2, nodes: {
      "task-1": { status: "completed" },
      "task-2": { status: "running" },
      "task-3": { status: "queued" },
    } };
    const view = toDagProgress(spec, raw);
    assert.equal(view.currentWave, 1);
    assert.equal(view.totalWaves, 2);
    // topology preserved from spec
    assert.deepEqual(view.nodes["task-3"].deps, ["task-1"]);
    // node states carried through
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
    // task-1, task-2 in wave 0 (no deps); task-3 in wave 1 (depends task-1)
    assert.equal(view.nodes["task-1"].wave, 0);
    assert.equal(view.nodes["task-2"].wave, 0);
    assert.equal(view.nodes["task-3"].wave, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test __tests__/progress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/dag/progress.ts`**

```ts
import type { DAGSpec } from "./types";

export type NodeStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface DagProgressView {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  nodes: Record<string, {
    task: string;
    deps: string[];
    status: NodeStatus;
    wave: number;
    error?: string;
  }>;
}

// Kahn's algorithm — topological layering. Mirrors planWaves() in executor.ts
// but reproduced here so the view is self-contained (pure, no executor dep).
function computeWaves(spec: DAGSpec): Record<string, number> {
  const wave: Record<string, number> = {};
  const remaining = new Map<string, string[]>();
  for (const [id, node] of Object.entries(spec.nodes)) {
    wave[id] = 0;
    remaining.set(id, [...(node.depends_on ?? [])]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of remaining) {
      if (deps.length === 0) continue;
      const maxDepWave = Math.max(...deps.map(d => wave[d] ?? 0), -1);
      if (deps.every(d => wave[d] >= 0 && remaining.get(d)!.length === 0)) {
        wave[id] = maxDepWave + 1;
        remaining.set(id, []);
        changed = true;
      }
    }
  }
  return wave;
}

export function toDagProgress(
  spec: DAGSpec,
  raw: { currentWave: number; totalWaves: number; nodes?: Record<string, { status: string; error?: string }> },
  dagId = "",
): DagProgressView {
  const waves = computeWaves(spec);
  const nodes: DagProgressView["nodes"] = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const r = raw.nodes?.[id];
    nodes[id] = {
      task: node.task,
      deps: node.depends_on ?? [],
      status: (r?.status as NodeStatus) ?? "queued",
      wave: waves[id],
      error: r?.error,
    };
  }
  return { dagId, currentWave: raw.currentWave, totalWaves: raw.totalWaves, nodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test __tests__/progress.test.ts`
Expected: PASS 3

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/dag/progress.ts __tests__/progress.test.ts
git commit -m "feat(dag): pure toDagProgress mapper (spec+raw → structured view w/ wave layering) + tests"
```

---

### Task 2: 纯渲染 renderDagGraph (TDD)
**Role:** coder | **Deps:** [1]

**Files:**
- Create: `src/dag/dag-graph.ts`
- Test: `__tests__/dag-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
  it("renders dependency edges (deps annotation on nodes with dependencies)", () => {
    const v: DagProgressView = {
      dagId: "d1", currentWave: 0, totalWaves: 2,
      nodes: {
        "task-1": { task: "A", deps: [], status: "completed", wave: 0 },
        "task-3": { task: "C after A", deps: ["task-1"], status: "queued", wave: 1 },
      },
    };
    const joined = renderDagGraph(v, 80).join("\n");
    // node with deps shows its dependency (edge)
    assert.match(joined, /task-3.*deps?:.*task-1|task-3.*→.*task-1|task-3.*←.*task-1/, "dep edge rendered");
    // node without deps does not show a deps annotation
    const t1Line = joined.split("\n").find(l => l.includes("task-1"))!;
    assert.doesNotMatch(t1Line, /deps?/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test __tests__/dag-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/dag/dag-graph.ts`**

```ts
import type { DagProgressView, NodeStatus } from "./progress";

export const STATUS_SYMBOL: Record<NodeStatus, string> = {
  queued: "○",
  running: "◐",
  completed: "✓",
  failed: "✗",
  skipped: "·",
};

// Render a DAG state graph as ASCII lines, width-bounded.
// Layout: header (wave progress) → per-wave block (wave label + node lines).
// Each node line: "  <symbol> <id>: <task> [<error>]"
// Pure string math — no TUI dep, fully unit-testable.
export function renderDagGraph(view: DagProgressView, width: number): string[] {
  const lines: string[] = [];
  const header = `DAG ${view.dagId || ""} — wave ${view.currentWave + 1}/${view.totalWaves}`.trim();
  lines.push(truncate(header, width));

  // group nodes by wave
  const byWave = new Map<number, string[]>();
  for (const [id, node] of Object.entries(view.nodes)) {
    if (!byWave.has(node.wave)) byWave.set(node.wave, []);
    byWave.get(node.wave)!.push(id);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b);
  for (const w of waves) {
    lines.push(truncate(`Wave ${w}`, width));
    for (const id of byWave.get(w)!) {
      const node = view.nodes[id];
      const sym = STATUS_SYMBOL[node.status];
      let line = `  ${sym} ${id}: ${node.task}`;
      if (node.deps.length > 0) line += `  [deps: ${node.deps.join(",")}]`;
      if (node.error) line += `  [${node.error}]`;
      lines.push(truncate(line, width));
    }
  }
  return lines;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test __tests__/dag-graph.test.ts`
Expected: PASS 6

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/dag/dag-graph.ts __tests__/dag-graph.test.ts
git commit -m "feat(dag): pure renderDagGraph (ASCII wave-grouped status graph) + tests"
```

---

### Task 3: 补 onProgress 桥接 (修复降级 bug)
**Role:** coder | **Deps:** [1]

**Files:**
- Modify: `src/dag/dag-execute-tool.ts` (onProgress 回调, ~line 167-170)

- [ ] **Step 1: Read current onProgress block**

Read `src/dag/dag-execute-tool.ts` around lines 164-172 to confirm the exact current text (the `details: undefined` line).

- [ ] **Step 2: Write the failing test for the bridging helper (TDD — test FIRST)**

The onProgress closure is inline and hard to reach directly, so we **extract it** into a pure helper `makeOnProgress(spec, onUpdate)` in `progress.ts` (added in Task 1's module — keep `toDagProgress` and `makeOnProgress` together). Test the helper, not the inline closure.

Append to `__tests__/progress.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test __tests__/progress.test.ts`
Expected: FAIL — `makeOnProgress` is not exported (doesn't exist yet).

- [ ] **Step 4: Implement makeOnProgress in `src/dag/progress.ts`**

```ts
export function makeOnProgress(
  spec: DAGSpec,
  onUpdate: (r: { content: any[]; details: any }) => void,
  dagId = "",
) {
  return (p: { currentWave: number; totalWaves: number; nodes?: Record<string, { status: string; error?: string }> }) => {
    const view = toDagProgress(spec, p, dagId);
    onUpdate({
      content: [{ type: "text" as const, text: `DAG wave ${p.currentWave + 1}/${p.totalWaves} running…` }],
      details: { kind: "dag-progress" as const, spec, progress: view },
    });
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test __tests__/progress.test.ts`
Expected: PASS (existing toDagProgress tests + new makeOnProgress tests).

- [ ] **Step 6: Wire makeOnProgress into dag-execute-tool.ts**

In `src/dag/dag-execute-tool.ts`:
- Add import: `import { makeOnProgress } from "./progress";`
- Replace the inline onProgress closure (~lines 167-170) with:
```ts
const onProgress = onUpdate ? makeOnProgress(spec, onUpdate) : undefined;
```
This removes the `details: undefined` bug — progress now flows structured.

- [ ] **Step 7: Run full dag test suite (regression) + typecheck**

Run:
```bash
npx tsx --test __tests__/dag-execute-tool.test.ts __tests__/dag-execute-tool-t1-4.test.ts __tests__/dag-executor-5c.test.ts __tests__/progress.test.ts
npx tsc --noEmit
```
Expected: all pass; tsc exit 0. The existing dag-execute-tool tests assert behavior of execute output (not onProgress internals), so they should be unaffected — but verify no regression.

- [ ] **Step 8: Commit**

```bash
git add src/dag/progress.ts src/dag/dag-execute-tool.ts __tests__/progress.test.ts
git commit -m "fix(dag): bridge onProgress to structured details (was undefined) — DAGProgress now flows to tool_execution_update"
```

---

### Task 4: dag-visibility extension (TDD 接线)
**Role:** coder | **Deps:** [1, 2, 3]

**Files:**
- Create: `src/dag/dag-visibility.ts`
- Test: `__tests__/dag-visibility.test.ts`

- [ ] **Step 1: Write the failing test with a fake pi that passes ctx to handlers**

> **Critical:** `ui` lives on the handler's `ctx` (2nd arg), NOT on `pi`. The fake-pi must pass a `ctx` with `ui` and `mode` to each emit, mirroring real pi. Testing `(pi as any).ui` would structurally hide the bug (fake supplies it, real pi doesn't have it).

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDagVisibility } from "../src/dag/dag-visibility";

// Minimal fake pi: handlers receive (e, ctx). ctx.ui.setWidget is the render sink.
// ctx.mode==='tui' gates rendering (rpc/json modes have no widget surface).
function fakePi(mode = "tui") {
  const handlers: Record<string, ((e: any, ctx: any) => void | Promise<void>)[]> = {};
  const widgets: Record<string, any> = {};
  const ctx = { mode, ui: { setWidget: (key: string, content: any) => { widgets[key] = content; } } };
  return {
    on(event: string, h: any) { (handlers[event] ??= []).push(h); },
    emit(event: string, e: any) { for (const h of handlers[event] ?? []) h(e, ctx); },
    widgets,
    hasHandler: (event: string) => (handlers[event]?.length ?? 0) > 0,
    setMode(m: string) { (ctx as any).mode = m; },
  };
}

describe("dag-visibility extension", () => {
  it("subscribes to tool_execution_update", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    assert.ok(pi.hasHandler("tool_execution_update"));
  });
  it("ignores non-dag_execute tool updates (no widget set)", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", { toolName: "bash", toolCallId: "t1", args: {}, partialResult: {} });
    assert.equal(pi.widgets["dag-visibility"], undefined);
  });
  it("renders + sets widget on dag_execute update with spec + progress", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", {
      toolName: "dag_execute", toolCallId: "t1",
      args: { spec: { nodes: { "task-1": { task: "A", depends_on: [] } } } },
      partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { "task-1": { task: "A", deps: [], status: "running", wave: 0 } } } } },
    });
    const w = pi.widgets["dag-visibility"];
    assert.ok(Array.isArray(w), "widget content is string[]");
    assert.ok(w.join("\n").includes("task-1"));
    assert.ok(w.join("\n").includes("◐"), "running symbol");
  });
  it("does NOT render in non-tui mode (rpc/json have no widget surface)", () => {
    const pi: any = fakePi("rpc");
    createDagVisibility(pi);
    pi.emit("tool_execution_update", {
      toolName: "dag_execute", toolCallId: "t1",
      args: { spec: { nodes: { "task-1": { task: "A", depends_on: [] } } } },
      partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { "task-1": { task: "A", deps: [], status: "running", wave: 0 } } } } } },
    });
    assert.equal(pi.widgets["dag-visibility"], undefined, "no widget in rpc mode");
  });
  it("clears widget on tool_execution_end for the same toolCallId", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", { toolName: "dag_execute", toolCallId: "t1", args: { spec: { nodes: { "task-1": { task: "A", depends_on: [] } } } }, partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { "task-1": { task: "A", deps: [], status: "running", wave: 0 } } } } } });
    pi.emit("tool_execution_end", { toolName: "dag_execute", toolCallId: "t1" });
    assert.equal(pi.widgets["dag-visibility"], undefined, "widget cleared on end");
  });
  it("keys concurrent DAGs by toolCallId (no cross-talk)", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", { toolName: "dag_execute", toolCallId: "t1", args: { spec: { nodes: { "A": { task: "A", depends_on: [] } } } }, partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { "A": { task: "A", deps: [], status: "running", wave: 0 } } } } } });
    pi.emit("tool_execution_update", { toolName: "dag_execute", toolCallId: "t2", args: { spec: { nodes: { "B": { task: "B", depends_on: [] } } } }, partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { "B": { task: "B", deps: [], status: "running", wave: 0 } } } } } });
    // ending t1 should NOT clear the widget if t2 still active
    pi.emit("tool_execution_end", { toolName: "dag_execute", toolCallId: "t1" });
    const w = pi.widgets["dag-visibility"];
    assert.ok(w && w.join("\n").includes("B"), "t2 still visible after t1 ends");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test __tests__/dag-visibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/dag/dag-visibility.ts`**

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toDagProgress, type DagProgressView } from "./progress";
import { renderDagGraph } from "./dag-graph";

const WIDGET_KEY = "dag-visibility";
const DEFAULT_WIDTH = 80;

// Track active DAG toolCallIds (concurrent-DAG isolation).
const active = new Set<string>();

function isDagExecute(e: any): boolean {
  return e?.toolName === "dag_execute";
}

function extractView(e: any): DagProgressView | null {
  const spec = e?.args?.spec;
  const progress = e?.partialResult?.details?.progress;
  if (!spec || !progress || e?.partialResult?.details?.kind !== "dag-progress") return null;
  return toDagProgress(spec, progress);
}

export function createDagVisibility(pi: ExtensionAPI): void {
  // ui lives on ctx (2nd arg), NOT on pi. Only tui mode has a widget surface.
  pi.on("tool_execution_update", (e: any, ctx: ExtensionContext) => {
    if (!isDagExecute(e)) return;
    if ((ctx as any).mode !== "tui") return; // rpc/json modes: no widget surface
    const view = extractView(e);
    if (!view) return;
    active.add(e.toolCallId);
    const lines = renderDagGraph(view, DEFAULT_WIDTH);
    ctx.ui.setWidget(WIDGET_KEY, lines);
  });
  pi.on("tool_execution_end", (e: any, ctx: ExtensionContext) => {
    if (!isDagExecute(e)) return;
    active.delete(e.toolCallId);
    if (active.size === 0 && (ctx as any).mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });
  // session_shutdown may not carry ctx in all modes; guard.
  pi.on("session_shutdown" as any, (e: any, ctx?: ExtensionContext) => {
    active.clear();
    if (ctx?.ui) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test __tests__/dag-visibility.test.ts`
Expected: PASS 6 (added the non-tui mode guard test)

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/dag/dag-visibility.ts __tests__/dag-visibility.test.ts
git commit -m "feat(dag): dag-visibility extension (subscribe tool_execution_update, render graph to widget, lifecycle + concurrent-DAG isolation) + tests"
```

---

### Task 5: 注册 extension + 全套回归
**Role:** coder | **Deps:** [4]

**Files:**
- Modify: `index.ts` (加载 dag-visibility)

- [ ] **Step 1: Read index.ts entry, find where to load the new extension**

The existing `index.ts` default export already loads pi-roles. Add a call to `createDagVisibility(pi)` after the existing registrations (e.g., after the `pi.registerTool(makeDagResumeTool(...))` line).

- [ ] **Step 2: Wire it**

In `index.ts`:
```ts
import { createDagVisibility } from "./src/dag/dag-visibility";
// ... after existing registerTool calls:
createDagVisibility(pi);
```

- [ ] **Step 3: Full test suite + typecheck (regression gate)**

Run:
```bash
npx tsc --noEmit
npm test
```
Expected: tsc exit 0; all tests pass (existing + new progress/dag-graph/dag-visibility).

- [ ] **Step 4: Scope-discipline grep**

```bash
# no pi-core changes
git diff --name-only | grep -E "pi-coding-agent" && echo "FAIL: pi-core changed" || echo "PASS: pi-core untouched"
# no spawn.ts / child session EventBus changes
git diff --name-only | grep -E "subagent/spawn.ts|subagent/auto-compact" && echo "FAIL: session isolation touched" || echo "PASS: session isolation untouched"
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add index.ts
git commit -m "feat(dag): wire dag-visibility extension into pi-roles entry"
```

---

### Task 6: Smoke runbook + goal evidence
**Role:** coder | **Deps:** [5]

**Files:**
- Create: `scripts/dag-visibility-smoke.md`

- [ ] **Step 1: Write the runbook**

```markdown
# DAG Visibility Smoke Test

## Prerequisites
- pi installed with pi-roles extension.
- A role that triggers dag_execute (or a manual prompt that makes the agent plan + execute a DAG).

## Steps
1. Start pi in a project: `pi`
2. Prompt the agent to do multi-step work that warrants a DAG, e.g.:
   "Use dag_execute to run: task-A (research X), task-B (research Y), task-C (depends on A, summarize). Plan it first."
3. While dag_execute runs, watch the TUI for a `dag-visibility` widget showing:
   - Header: "DAG — wave N/M"
   - Per-wave blocks with nodes and status symbols: ○ queued / ◐ running / ✓ completed / ✗ failed
4. As waves progress, the widget should update (statuses flip queued→running→completed).
5. When dag_execute ends, the widget clears.

## Pass criteria
- [ ] DAG widget appears during dag_execute
- [ ] Node statuses visible and update over time
- [ ] Widget clears on completion
- [ ] No token cost (details doesn't enter LLM context — verify via /context if available)
```

- [ ] **Step 2: Commit + update goal evidence**

```bash
git add scripts/dag-visibility-smoke.md
git commit -m "docs: DAG visibility smoke runbook"
```

Then update goal criteria with evidence (per-criterion) and mark goal complete once smoke verified (manual E2E may be deferred — record that).

---

## Self-Review

**1. Spec coverage:**
- DAG 状态图（节点+状态+wave+边）→ Tasks 2 (render) + 4 (widget) ✓
- 数据层桥接（onProgress 不再降级）→ Task 3 ✓
- 透传链路验证 → Task 1 test + Task 4 subscription ✓
- 只读不操控 → Task 4 only reads, no control API ✓ (constraint)
- 不碰 pi-core / 子 session → Task 5 grep gate ✓
- widget 生命周期 + 并发键化 → Task 4 (active Set + toolCallId) ✓
- TDD → every pure unit tested first ✓
- runbook → Task 6 ✓

**2. Placeholder scan:** Task 3 originally had a comment-only failing test + TDD-order inversion + a dangling file reference — rewritten so makeOnProgress test precedes implementation (reviewer-caught). Task 4 originally used `(pi as any).ui` which doesn't exist on pi (ui is on ctx) and the fake-pi structurally hid it — fixed to `(e, ctx) => ctx.ui.setWidget` + `ctx.mode==='tui'` guard + a non-tui mode test (reviewer-caught, most serious). renderDagGraph now renders dependency edges `[deps: ...]` with a test (reviewer-caught spec gap). No other TBDs.

**3. Type consistency:** `DagProgressView` defined in progress.ts, used in dag-graph.ts + dag-visibility.ts consistently. `STATUS_SYMBOL` exported from dag-graph. `makeOnProgress`/`toDagProgress` in progress.ts.

**4. DAG sanity:** Tasks 1,2 independent-ish (2 deps on 1's type). 3 deps 1. 4 deps 1,2,3. 5 deps 4. 6 deps 5. Linear-ish, no parallel conflicts (different files mostly; Task 3 touches dag-execute-tool.ts + progress.ts, Task 1 creates progress.ts — sequential).

Reviewing with a fresh-eyes reviewer subagent before execution.
