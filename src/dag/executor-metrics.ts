import type {
  DAGAdmissionDiagnostic,
  DAGNodeState,
  DAGResult,
  DAGSpec,
  NodePayload,
  NodeResult,
  WorkflowLineage,
  WaveResult,
} from "./types";
import type { Wave } from "./planner";
import type { ExecutionCounters } from "./executor-contract";
import { copyStates } from "./executor-payload";

export function computeTopology(waves: Wave[]): {
  waveByNode: Map<string, number>;
  remainingCriticalPath: Map<string, number>;
} {
  const waveByNode = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const wave of waves) {
    for (const node of wave.nodes) {
      waveByNode.set(node.id, wave.index);
      dependents.set(node.id, []);
    }
  }
  for (const wave of waves) {
    for (const node of wave.nodes) {
      for (const dep of node.deps) dependents.get(dep)?.push(node.id);
    }
  }
  const remainingCriticalPath = new Map<string, number>();
  for (const wave of [...waves].reverse()) {
    for (const node of wave.nodes) {
      const childDepth = Math.max(0, ...(dependents.get(node.id) ?? []).map((id) => remainingCriticalPath.get(id) ?? 1));
      remainingCriticalPath.set(node.id, 1 + childDepth);
    }
  }
  return { waveByNode, remainingCriticalPath };
}

function projectWaves(waves: Wave[], nodeResults: Map<string, NodeResult>): WaveResult[] {
  let lastSettledWave = -1;
  for (const wave of waves) {
    if (wave.nodes.some((node) => nodeResults.has(node.id))) lastSettledWave = wave.index;
  }
  if (lastSettledWave < 0) return [];
  return waves.slice(0, lastSettledWave + 1).map((wave) => {
    const results = wave.nodes.map((node) => nodeResults.get(node.id)).filter((result): result is NodeResult => Boolean(result));
    return {
      wave: wave.index,
      successes: results.filter((result) => result.status === "completed"),
      failures: results.filter((result) => result.status === "failed"),
      skipped: results.filter((result) => result.status === "skipped"),
    };
  });
}

function elapsedMs(start: number | undefined, end: number): number {
  return start === undefined ? 0 : Math.max(0, end - start);
}

function buildNodeTimings(
  states: Record<string, DAGNodeState>,
  finishedAt: number,
): NonNullable<DAGResult["metrics"]>["nodeTimings"] {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => {
    const queueEnd = state.startedAt ?? state.finishedAt ?? finishedAt;
    const runEnd = state.finishedAt ?? finishedAt;
    return [id, {
      queueTimeMs: elapsedMs(state.readyAt, queueEnd),
      runTimeMs: elapsedMs(state.startedAt, runEnd),
    }];
  }));
}

function computeCriticalPathMs(
  spec: DAGSpec,
  nodeTimings: NonNullable<DAGResult["metrics"]>["nodeTimings"],
): number {
  const longestTo = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = longestTo.get(id);
    if (cached !== undefined) return cached;
    const upstream = Math.max(0, ...(spec.nodes[id]?.depends_on ?? []).map(visit));
    const duration = nodeTimings[id]?.runTimeMs ?? 0;
    const total = upstream + duration;
    longestTo.set(id, total);
    return total;
  };
  return Math.max(0, ...Object.keys(spec.nodes).map(visit));
}

export function buildResult(
  spec: DAGSpec,
  waves: Wave[],
  nodeResults: Map<string, NodeResult>,
  states: Record<string, DAGNodeState>,
  termination: DAGResult["termination"],
  peakConcurrent: number,
  maxConcurrent: number,
  startedAt: number,
  finishedAt: number,
  counters: ExecutionCounters,
  admissionDiagnostics: DAGAdmissionDiagnostic[],
  workflow: WorkflowLineage,
): DAGResult {
  const counts = { completed: 0, failed: 0, skipped: 0, queued: 0, running: 0 };
  const finalContext: Record<string, NodePayload> = {};
  for (const [id, state] of Object.entries(states)) {
    counts[state.status]++;
    const result = nodeResults.get(id);
    if (result?.status === "completed" && result.result) finalContext[id] = result.result;
  }
  const allTerminal = counts.queued === 0 && counts.running === 0;
  let status: DAGResult["status"];
  if (Object.keys(spec.nodes).length > 0 && termination === "all_terminal" && allTerminal && counts.failed === 0) status = "completed";
  else if (counts.completed > 0 || counts.skipped > 0) status = "partial";
  else status = "failed";
  const nodeTimings = buildNodeTimings(states, finishedAt);
  const wallTimeMs = elapsedMs(startedAt, finishedAt);
  return {
    status,
    workflow,
    waves: projectWaves(waves, nodeResults),
    finalContext,
    nodeStates: copyStates(states),
    termination,
    metrics: {
      totalNodes: Object.keys(spec.nodes).length,
      ...counts,
      maxConcurrent,
      peakConcurrent,
      durationMs: wallTimeMs,
      wallTimeMs,
      serialTimeMs: Object.values(nodeTimings).reduce((sum, timing) => sum + timing.runTimeMs, 0),
      criticalPathMs: computeCriticalPathMs(spec, nodeTimings),
      ...counters,
      nodeTimings,
    },
    ...(admissionDiagnostics.length > 0 ? { admissionDiagnostics } : {}),
  };
}
