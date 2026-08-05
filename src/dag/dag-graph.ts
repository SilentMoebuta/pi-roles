import type { DagProgressView, NodeStatus } from "./progress";

export const STATUS_SYMBOL: Record<NodeStatus, string> = {
  queued: "○",
  running: "◐",
  completed: "✓",
  failed: "✗",
  skipped: "·",
};

// Display width of a string in a monospace terminal.
// CJK + full-width chars count as 2 columns; ASCII/control count as 1.
// This is the fix for the real-world bug where `s.length` (code points)
// was used to bound line width — 40 Chinese chars = 80 display cols would
// pass a length<=80 check but overflow an 80-col widget, forcing the TUI
// to wrap and make the DAG overview unreadable.
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs + common full-width ranges → 2 cols.
    // Conservative: treat anything in the CJK/fullwidth Unicode blocks as 2.
    if (
      (c >= 0x1100 && c <= 0x115f) ||  // Hangul Jamo
      (c >= 0x2e80 && c <= 0x303e) ||   // CJK Radicals / Kangxi
      (c >= 0x3040 && c <= 0x33bf) ||   // Hiragana/Katakana/CJK symbols
      (c >= 0x3400 && c <= 0x4dbf) ||   // CJK Ext A
      (c >= 0x4e00 && c <= 0xa4cf) ||   // CJK Unified + Yi
      (c >= 0xac00 && c <= 0xd7a3) ||   // Hangul Syllables
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK Compat Ideographs
      (c >= 0xfe30 && c <= 0xfe6f) ||   // CJK Compat Forms
      (c >= 0xff00 && c <= 0xff60) ||   // Fullwidth Forms
      (c >= 0xffe0 && c <= 0xffe6) ||   // Fullwidth signs
      (c >= 0x1f300 && c <= 0x1faff)    // Emoji / symbols (treat as 2)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Truncate by DISPLAY width (CJK-aware), appending … if cut.
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let w = 0;
  let out = "";
  const ellipsis = "…";
  const budget = Math.max(0, width - displayWidth(ellipsis));
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

// Short label for a node: the task text truncated to a readable overview length.
// Full task text is a long research brief — rendering it whole makes the widget
// unreadable. We keep only the first ~24 display cols as a label.
const LABEL_DISPLAY_WIDTH = 24;

function shortLabel(task: string): string {
  return truncate(task, LABEL_DISPLAY_WIDTH);
}

const MAX_VISIBLE_PER_GROUP = 4;

function renderNodeLine(id: string, view: DagProgressView, width: number): string {
  const node = view.nodes[id];
  const meta: string[] = [];
  if (view.frontier.critical.includes(id)) meta.push(`path=${node.remainingPath}`);
  if (node.priority) meta.push(`p=${node.priority}`);
  if (node.role) meta.push(`role=${node.role}`);
  if (node.generatedFrom) meta.push(`from=${node.generatedFrom}`);
  if (node.route) meta.push(`route=${node.route}`);
  if (node.waitingOn.length > 0) meta.push(`wait=${node.waitingOn.join(",")}`);
  if (node.blockReason === "wave_barrier") meta.push("wait=wave-barrier");
  if (node.error) meta.push(`[${truncate(node.error, 20)}]`);
  const suffix = meta.length > 0 ? `  ${meta.join(" ")}` : "";
  return truncate(`  ${STATUS_SYMBOL[node.status]} ${id}: ${shortLabel(node.task)}${suffix}`, width);
}

function appendNodeGroup(
  lines: string[],
  title: string,
  ids: string[],
  view: DagProgressView,
  width: number,
): void {
  if (ids.length === 0) return;
  lines.push(truncate(`${title} (${ids.length})`, width));
  for (const id of ids.slice(0, MAX_VISIBLE_PER_GROUP)) {
    lines.push(renderNodeLine(id, view, width));
  }
  if (ids.length > MAX_VISIBLE_PER_GROUP) {
    lines.push(truncate(`  … +${ids.length - MAX_VISIBLE_PER_GROUP} more`, width));
  }
}

// Render the scheduler frontier, not a synthetic wave timeline. Wave fields
// remain in DagProgressView for old consumers but are deliberately absent from
// the primary display: ready scheduling can advance one branch while an
// unrelated earlier layer is still running.
export function renderDagGraph(view: DagProgressView, width: number): string[] {
  const lines: string[] = [];
  const total = Object.keys(view.nodes).length;
  const f = view.frontier;
  const scheduler = view.scheduler ?? "wave";
  const identity = view.dagId ? ` · ${view.dagId}` : "";
  lines.push(truncate(`DAG · ${view.outcome.toUpperCase()}${identity} · frontier · ${scheduler} scheduler`, width));
  const activity = `Running ${f.running.length} · Ready ${f.ready.length} · Blocked ${f.blocked.length} · Settled ${f.settled.length}/${total}`;
  lines.push(truncate(f.failed.length > 0 ? `FAILED ${f.failed.length} · ${activity}` : activity, width));

  appendNodeGroup(lines, "Failed", f.failed, view, width);
  appendNodeGroup(lines, "Running", f.running, view, width);
  appendNodeGroup(lines, "Ready", f.ready, view, width);
  appendNodeGroup(lines, "Blocked / waiting", f.blocked, view, width);

  const completed = f.settled.filter((id) => view.nodes[id].status === "completed").length;
  const skipped = f.settled.filter((id) => view.nodes[id].status === "skipped").length;
  lines.push(truncate(`Settled  ${STATUS_SYMBOL.completed}${completed} ${STATUS_SYMBOL.skipped}${skipped} ${STATUS_SYMBOL.failed}${f.failed.length}`, width));

  const routes = Object.entries(view.routeDecisions);
  if (routes.length > 0) {
    lines.push(truncate(`Routes  ${routes.map(([id, route]) => `${id}=${route}`).join(" · ")}`, width));
  }
  const generated = Object.values(view.generatedNodes);
  if (generated.length > 0) {
    const parents = [...new Set(generated.map((node) => node.parentId))];
    lines.push(truncate(`Generated ${generated.length} from ${parents.join(",")}`, width));
  }
  return lines;
}
