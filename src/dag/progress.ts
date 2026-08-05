import type { DAGNodeStatus, DAGProgress, DAGResult, DAGScheduler, DAGSpec, GeneratedNodeRecord } from "./types";

export type NodeStatus = DAGNodeStatus;
export type DagProgressOutcome = "active" | DAGResult["status"];

export interface DagProgressView {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  scheduler?: DAGScheduler;
  outcome: DagProgressOutcome;
  termination?: NonNullable<DAGResult["termination"]>;
  /** Scheduler-facing categories. `blocked` means dependency-blocked queued
   *  work, not a terminal DAG failure. `settled` contains every terminal node. */
  frontier: {
    running: string[];
    ready: string[];
    blocked: string[];
    settled: string[];
    failed: string[];
    critical: string[];
  };
  routeDecisions: Record<string, string>;
  generatedNodes: Record<string, GeneratedNodeRecord>;
  nodes: Record<string, {
    task: string;
    deps: string[];
    status: NodeStatus;
    wave: number;
    role?: string;
    priority?: number;
    waitingOn: string[];
    blockReason?: "dependencies" | "wave_barrier";
    /** Structural node count on the longest remaining downstream path. This
     *  is scheduler priority context, not a duration estimate. */
    remainingPath: number;
    generatedFrom?: string;
    error?: string;
    route?: string;
  }>;
}

// Topological layering. Mirrors planWaves() in executor.ts but is reproduced
// here so the view is self-contained (pure, no executor dependency).
function computeWaves(spec: DAGSpec): Record<string, number> {
  const memo: Record<string, number> = {};
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (memo[id] !== undefined) return memo[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = spec.nodes[id]?.depends_on ?? [];
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => visit(dep))) + 1;
    visiting.delete(id);
    memo[id] = value;
    return value;
  };
  for (const id of Object.keys(spec.nodes)) visit(id);
  return memo;
}

function computeRemainingPaths(spec: DAGSpec): Record<string, number> {
  const successors = new Map<string, string[]>();
  for (const id of Object.keys(spec.nodes)) successors.set(id, []);
  for (const [id, node] of Object.entries(spec.nodes)) {
    for (const dep of node.depends_on ?? []) successors.get(dep)?.push(id);
  }
  const memo: Record<string, number> = {};
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (memo[id] !== undefined) return memo[id];
    if (visiting.has(id)) return 1;
    visiting.add(id);
    const next = successors.get(id) ?? [];
    const value = 1 + (next.length === 0 ? 0 : Math.max(...next.map(visit)));
    visiting.delete(id);
    memo[id] = value;
    return value;
  };
  for (const id of Object.keys(spec.nodes)) visit(id);
  return memo;
}

function isTerminal(status: NodeStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export function toDagProgress(
  spec: DAGSpec,
  raw: {
    dagId?: string;
    currentWave: number;
    totalWaves: number;
    scheduler?: DAGScheduler;
    outcome?: DAGResult["status"];
    termination?: NonNullable<DAGResult["termination"]>;
    explicitStates?: boolean;
    nodes?: Record<string, { status: string; error?: string; route?: string }>;
    generatedNodes?: Record<string, GeneratedNodeRecord>;
  },
  dagId = "",
): DagProgressView {
  const waves = computeWaves(spec);
  const remainingPaths = computeRemainingPaths(spec);
  const nodes: DagProgressView["nodes"] = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const r = raw.nodes?.[id];
    let status: NodeStatus;
    if (r?.status) {
      // explicit status from raw — trust it (covers running/failed/queued of current wave)
      status = r.status as NodeStatus;
    } else if (raw.explicitStates !== true && waves[id] < raw.currentWave) {
      // node is in a wave BEFORE the current one, and executor's onProgress
      // only reports the current wave's nodes — so absence here means the
      // node's wave already completed. Default to 'completed' (otherwise the
      // widget would lie: show past waves as 0/N queued while currentWave advanced).
      status = "completed";
    } else {
      // current/future wave with no explicit status → queued
      status = "queued";
    }
    nodes[id] = {
      task: node.task,
      deps: node.depends_on ?? [],
      status,
      wave: waves[id],
      role: node.role,
      priority: node.priority,
      waitingOn: [],
      remainingPath: remainingPaths[id] ?? 1,
      generatedFrom: raw.generatedNodes?.[id]?.parentId,
      error: r?.error,
      route: r?.route,
    };
  }

  const frontier: DagProgressView["frontier"] = {
    running: [], ready: [], blocked: [], settled: [], failed: [], critical: [],
  };
  const routeDecisions: Record<string, string> = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (node.route) routeDecisions[id] = node.route;
    if (isTerminal(node.status)) {
      frontier.settled.push(id);
      if (node.status === "failed") frontier.failed.push(id);
      continue;
    }
    if (node.status === "running") {
      frontier.running.push(id);
      continue;
    }
    node.waitingOn = node.deps.filter((dep) => !nodes[dep] || !isTerminal(nodes[dep].status));
    // Missing scheduler identifies a legacy wave producer.
    const waveBlocked = (raw.scheduler ?? "wave") === "wave" && node.wave !== raw.currentWave;
    if (node.waitingOn.length === 0 && !waveBlocked) {
      frontier.ready.push(id);
    } else {
      node.blockReason = node.waitingOn.length > 0 ? "dependencies" : "wave_barrier";
      frontier.blocked.push(id);
    }
  }
  const active = [...frontier.running, ...frontier.ready];
  const longest = Math.max(0, ...active.map((id) => nodes[id].remainingPath));
  frontier.critical = active.filter((id) => nodes[id].remainingPath === longest);
  const total = Object.keys(nodes).length;
  const inferredOutcome: DagProgressOutcome = total === 0
    ? "failed"
    : frontier.settled.length < total
      ? "active"
      : frontier.failed.length === 0
        ? "completed"
        : frontier.settled.length > frontier.failed.length
          ? "partial"
          : "failed";

  return {
    dagId: dagId || raw.dagId || "",
    currentWave: raw.currentWave,
    totalWaves: raw.totalWaves,
    scheduler: raw.scheduler,
    outcome: raw.outcome ?? inferredOutcome,
    termination: raw.termination,
    frontier,
    routeDecisions,
    generatedNodes: { ...(raw.generatedNodes ?? {}) },
    nodes,
  };
}

/** Compact, topology-independent activity text for tool streaming surfaces. */
export function summarizeDagFrontier(view: DagProgressView): string {
  const total = Object.keys(view.nodes).length;
  const f = view.frontier;
  const failed = f.failed.length > 0 ? ` · failed=${f.failed.length}` : "";
  return `DAG frontier: outcome=${view.outcome}${failed} · ${f.running.length} running · ${f.ready.length} ready · ${f.blocked.length} blocked · ${f.settled.length}/${total} settled`;
}

// Bridge: wrap raw executor progress into the structured onUpdate payload.
// Fixes the regression where details was set to `undefined` (dag-execute-tool.ts),
// dropping the structured progress before it could reach tool_execution_update.
export function makeOnProgress(
  spec: DAGSpec,
  onUpdate: (r: { content: any[]; details: any }) => void,
  dagId = "",
) {
  return (p: Omit<DAGProgress, "dagId"> & { dagId?: string }) => {
    const activeSpec = p.expandedSpec ?? spec;
    const view = toDagProgress(activeSpec, p, dagId);
    onUpdate({
      content: [{ type: "text" as const, text: summarizeDagFrontier(view) }],
      details: { kind: "dag-progress" as const, spec: activeSpec, progress: view },
    });
  };
}
