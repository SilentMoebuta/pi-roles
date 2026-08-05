import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toDagProgress, type DagProgressView } from "./progress";
import { renderDagGraph } from "./dag-graph";

const WIDGET_KEY = "dag-visibility";
const DEFAULT_WIDTH = 80;

function isDagTool(e: any): boolean {
  return e?.toolName === "dag_execute" || e?.toolName === "dag_resume";
}

function extractView(e: any): DagProgressView | null {
  const details = e?.partialResult?.details;
  const spec = details?.spec ?? e?.args?.spec;
  const progress = details?.progress;
  if (!spec || !progress || details?.kind !== "dag-progress") return null;
  return toDagProgress(spec, progress, progress.dagId);
}

export function createDagVisibility(pi: ExtensionAPI): void {
  // Per-extension state prevents concurrent sessions/tests from sharing active
  // tool ids. Map values also let us restore another DAG when the latest ends.
  const active = new Map<string, DagProgressView>();
  // ui lives on ctx (2nd arg), NOT on pi. Only tui mode has a widget surface.
  pi.on("tool_execution_update", (e: any, ctx: ExtensionContext) => {
    if (!isDagTool(e)) return;
    if ((ctx as any).mode !== "tui") return; // rpc/json/print modes: no widget surface
    const view = extractView(e);
    if (!view) return;
    active.set(e.toolCallId, view);
    const lines = renderDagGraph(view, DEFAULT_WIDTH);
    ctx.ui.setWidget(WIDGET_KEY, lines);
  });
  pi.on("tool_execution_end", (e: any, ctx: ExtensionContext) => {
    if (!isDagTool(e)) return;
    active.delete(e.toolCallId);
    if ((ctx as any).mode !== "tui") return;
    const remaining = [...active.values()].at(-1);
    if (remaining) {
      ctx.ui.setWidget(WIDGET_KEY, renderDagGraph(remaining, DEFAULT_WIDTH));
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });
  // session_shutdown may not carry ctx in all modes; guard.
  pi.on("session_shutdown" as any, (e: any, ctx?: ExtensionContext) => {
    active.clear();
    if (ctx?.ui) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
