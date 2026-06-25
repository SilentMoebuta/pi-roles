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
// Each node line: "  <symbol> <id>: <task>  [deps: a,b]  [error]"
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
    lines.push(truncate(`Wave ${w}`, width));
    for (const id of byWave.get(w)!) {
      const node = view.nodes[id];
      const sym = STATUS_SYMBOL[node.status];
      let line = `  ${sym} ${id}: ${node.task}`;
      if (node.error) line += `  [${node.error}]`;
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

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}
