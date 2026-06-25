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

// Determine whether a wave should be expanded (show node details) or collapsed
// (one-line summary). Expand the wave containing the current/active work; also
// expand a wave that has a running or failed node (so failures stay visible).
// Fully-completed and not-yet-started waves collapse to a summary line.
function shouldExpandWave(wave: number, view: DagProgressView): boolean {
  if (wave === view.currentWave) return true;
  // also expand if any node in this wave is running or failed (active/needs attention)
  for (const node of Object.values(view.nodes)) {
    if (node.wave === wave && (node.status === "running" || node.status === "failed")) return true;
  }
  return false;
}

// Render a collapsed wave summary line, e.g. "Wave 0  ✓ 3/3".
function collapseWaveLine(wave: number, ids: string[], view: DagProgressView, width: number): string {
  let done = 0, total = ids.length;
  let sym = "○";
  for (const id of ids) {
    const st = view.nodes[id]?.status;
    if (st === "completed") done++;
  }
  if (done === total) sym = "✓";
  else if (done > 0) sym = "◐";
  return truncate(`Wave ${wave}  ${sym} ${done}/${total}`, width);
}

// Render a DAG state graph as ASCII lines, width-bounded (CJK-aware).
// Layout: header (wave progress) → per-wave block.
// DYNAMIC: the active wave (currentWave, or any wave with running/failed nodes)
// is expanded with full node + dep-edge detail; completed and not-yet-started
// waves collapse to a one-line summary. Keeps the widget compact and focused
// on what's happening now.
// Pure string math — no TUI dep, fully unit-testable.
export function renderDagGraph(view: DagProgressView, width: number): string[] {
  const lines: string[] = [];
  const header = `DAG ${view.dagId || ""} — wave ${view.currentWave + 1}/${view.totalWaves}`.trim();
  lines.push(truncate(header, width));

  const byWave = new Map<number, string[]>();
  for (const [id, node] of Object.entries(view.nodes)) {
    if (!byWave.has(node.wave)) byWave.set(node.wave, []);
    byWave.get(node.wave)!.push(id);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b);
  for (const w of waves) {
    const ids = byWave.get(w)!;
    if (!shouldExpandWave(w, view)) {
      lines.push(collapseWaveLine(w, ids, view, width));
      continue;
    }
    lines.push(truncate(`Wave ${w}`, width));
    for (const id of ids) {
      const node = view.nodes[id];
      const sym = STATUS_SYMBOL[node.status];
      let line = `  ${sym} ${id}: ${shortLabel(node.task)}`;
      if (node.error) line += `  [${truncate(node.error, 20)}]`;
      lines.push(truncate(line, width));
      // Dependency edges: render each dep as a box-line connector (tree-style),
      // using └─ (terminator) for the last dep and ├─ (branch) for the rest —
      // genuine ASCII box-drawing edges, not a text "[deps:]" annotation.
      node.deps.forEach((depId, i) => {
        const isLast = i === node.deps.length - 1;
        const connector = isLast ? "└─" : "├─";
        const depNode = view.nodes[depId];
        const depSym = depNode ? STATUS_SYMBOL[depNode.status] : "?";
        lines.push(truncate(`  ${connector} ${depSym} ${depId}`, width));
      });
    }
  }
  return lines;
}
