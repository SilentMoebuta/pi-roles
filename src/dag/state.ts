// 5d: aggregate wave results into a final DAGResult and build error-context
// prefixes so downstream nodes know which predecessor failed and why.
import type { WaveResult, DAGResult, NodePayload } from "./types";

export function aggregateWaves(waves: WaveResult[]): DAGResult {
  const finalContext: Record<string, NodePayload> = {};
  let failures = 0;
  let total = 0;
  for (const w of waves) {
    for (const s of w.successes) {
      finalContext[s.nodeId] = s.result ?? { findings: [], artifacts: [] };
    }
    failures += w.failures.length;
    total += w.successes.length + w.failures.length + (w.skipped?.length ?? 0);
  }
  const status: DAGResult["status"] =
    failures === 0 ? "completed" : failures < total ? "partial" : "failed";
  return { status, waves, finalContext };
}

// Prefix prepended to a downstream node's task when a predecessor failed,
// so the node can decide: retry, skip, fallback, or escalate.
export function errorContextPrefix(failedNode: string, errorMessage: string): string {
  return `\n[Predecessor '${failedNode}' failed: ${errorMessage}]. Decide: retry, skip, fallback, or escalate.`;
}

// Prefix appended to a node's task with the ACTUAL results of completed
// predecessors (Gap D — static nodes received no upstream data, only their
// planned task string). The downstream node (e.g. reviewer) can parse this
// JSON block to discover the real artifacts produced by upstream coders,
// rather than relying on the planner's guesses.
export function upstreamResultsPrefix(completed: Record<string, NodePayload>): string {
  return `\n[Upstream results: ${JSON.stringify(completed)}]`;
}
