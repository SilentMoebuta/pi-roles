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
    if ((ctx as any).mode !== "tui") return; // rpc/json/print modes: no widget surface
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
