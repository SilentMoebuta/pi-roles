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

const PROGRESS_EVT = (toolCallId: string, task: string) => ({
  toolName: "dag_execute", toolCallId,
  args: { spec: { nodes: { [task]: { task, depends_on: [] } } } },
  partialResult: { details: { kind: "dag-progress", progress: { currentWave: 0, totalWaves: 1, nodes: { [task]: { task, deps: [], status: "running", wave: 0 } } } } },
});

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
    pi.emit("tool_execution_update", PROGRESS_EVT("t1", "task-1"));
    const w = pi.widgets["dag-visibility"];
    assert.ok(Array.isArray(w), "widget content is string[]");
    assert.ok(w.join("\n").includes("task-1"));
    assert.ok(w.join("\n").includes("◐"), "running symbol");
  });
  it("does NOT render in non-tui mode (rpc/json have no widget surface)", () => {
    const pi: any = fakePi("rpc");
    createDagVisibility(pi);
    pi.emit("tool_execution_update", PROGRESS_EVT("t1", "task-1"));
    assert.equal(pi.widgets["dag-visibility"], undefined, "no widget in rpc mode");
  });
  it("clears widget on tool_execution_end for the same toolCallId", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", PROGRESS_EVT("t1", "task-1"));
    pi.emit("tool_execution_end", { toolName: "dag_execute", toolCallId: "t1" });
    assert.equal(pi.widgets["dag-visibility"], undefined, "widget cleared on end");
  });
  it("keys concurrent DAGs by toolCallId (no cross-talk)", () => {
    const pi: any = fakePi();
    createDagVisibility(pi);
    pi.emit("tool_execution_update", PROGRESS_EVT("t1", "A"));
    pi.emit("tool_execution_update", PROGRESS_EVT("t2", "B"));
    pi.emit("tool_execution_end", { toolName: "dag_execute", toolCallId: "t1" });
    const w = pi.widgets["dag-visibility"];
    assert.ok(w && w.join("\n").includes("B"), "t2 still visible after t1 ends");
  });
});
