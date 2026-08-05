import type {
  DAGExecutionSnapshot,
  DAGAdmissionDiagnostic,
  DAGNode,
  DAGNodeExecutionMode,
  DAGNodeState,
  DAGProgress,
  DAGResult,
  DAGScheduler,
  DAGSpec,
  DispatchExpansionRecord,
  GeneratedNodeRecord,
  NodePayload,
  NodeResult,
  WaveResult,
} from "./types";
import { planWaves, type PlannedNode, type Wave } from "./planner";
import { errorContextPrefix, upstreamResultsPrefix } from "./state";
import type { DynamicNodeContext } from "./send";
import { sendToTask, type Send } from "./send";
import type { InlineRoleDef } from "../subagent/spawn-role-tool";
import { normalizeWriteScope, WriteScopeLeases } from "./scope";
import { expandDispatchNode, generatedNodeId } from "./expansion";
import {
  DEFAULT_MAX_DISPATCH_CHILDREN,
  HARD_MAX_DISPATCH_CHILDREN,
  hasSemanticContract,
  validateDAG,
  validateGeneratedSends,
} from "./validate";

export const DEFAULT_MAX_CONCURRENT = 5;
export const HARD_MAX_CONCURRENT = 20;

export type SpawnOutcomeStatus = "completed" | "aborted" | "error" | "failed";

export interface SpawnHandle {
  agentId: string;
  wait: () => Promise<{
    status: SpawnOutcomeStatus;
    result?: NodePayload;
    error?: string;
    reportPayload?: Record<string, unknown>;
  }>;
  /** Optional best-effort cancellation, used when a node times out. */
  abort?: () => void;
}

export type SpawnFn = (
  role: string | undefined,
  task: string,
  roleDef?: InlineRoleDef,
  model?: string,
  thinkingLevel?: string,
  routes?: Record<string, string[]>,
  /** Present only when this spawned node must return a result-driven Send[]. */
  dispatchMaxChildren?: number,
) => Promise<SpawnHandle>;

export interface ExecuteOptions {
  initialNodeResults?: Map<string, NodeResult>;
  initialNodeStates?: Record<string, DAGNodeState>;
  /** Legacy V1 resume fields. Results are projected into explicit node state. */
  startWaveIndex?: number;
  priorWaveResults?: WaveResult[];
  initialSkipReasons?: Map<string, string>;
  initialGeneratedNodes?: Record<string, GeneratedNodeRecord>;
  initialDispatchExpansions?: Record<string, DispatchExpansionRecord>;
  /** Original execution modes from a V2 checkpoint. Required on resume
   * because JSON serialization removes legacy dynamic closures. */
  initialNodeModes?: Record<string, DAGNodeExecutionMode>;
  maxConcurrent?: number;
  scheduler?: DAGScheduler;
  /** Optional role catalog used to preflight both declared and runtime-generated
   *  children before any member of a fan-out batch is spawned. */
  knownRoles?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  onProgress?: (p: DAGProgress) => void;
  onCheckpoint?: (snapshot: DAGExecutionSnapshot) => void;
  signal?: AbortSignal;
  /** Injectable monotonic wall clock for deterministic metrics tests. */
  now?: () => number;
  /** @deprecated Wave count is not nesting depth; retained as a no-op. */
  maxDepth?: number;
}

interface SpawnOutcome {
  status: SpawnOutcomeStatus;
  result?: NodePayload;
  error?: string;
  reportPayload?: Record<string, unknown>;
}

interface ExecutionCounters {
  routeCount: number;
  dispatchCount: number;
  downstreamResultConsumptionCount: number;
}

function cloneDispatchExpansion(record: DispatchExpansionRecord): DispatchExpansionRecord {
  return {
    ...record,
    generatedNodeIds: [...record.generatedNodeIds],
    sends: record.sends.map((send) => structuredClone(send)),
    dispatcherResult: record.dispatcherResult ? structuredClone(record.dispatcherResult) : undefined,
  };
}

function isTerminal(status: DAGNodeState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function copyStates(states: Record<string, DAGNodeState>): Record<string, DAGNodeState> {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { ...state }]));
}

function normalizePayload(outcome: SpawnOutcome): NodePayload {
  const payload = outcome.reportPayload ?? outcome.result;
  if (payload && Array.isArray((payload as NodePayload).findings) && Array.isArray((payload as NodePayload).artifacts)) {
    return {
      findings: (payload as NodePayload).findings,
      artifacts: (payload as NodePayload).artifacts,
      ...payload,
    };
  }
  return {
    ...(payload ?? {}),
    findings: payload ? [JSON.stringify(payload)] : [],
    artifacts: [],
  };
}

export function mergePayloads(payloads: NodePayload[]): NodePayload {
  const merged: NodePayload = {
    findings: payloads.flatMap((result) => result.findings),
    artifacts: payloads.flatMap((result) => result.artifacts),
  };
  if (payloads.length === 1) {
    Object.assign(merged, payloads[0], { findings: merged.findings, artifacts: merged.artifacts });
  }
  return merged;
}

function appendSemanticContract(
  task: string,
  expectedOutput: string | undefined,
  consumers: string[] | undefined,
): string {
  if (expectedOutput === undefined && consumers === undefined) return task;
  return `${task}\n\n[Semantic output contract]\nExpected output: ${expectedOutput?.trim() ?? ""}\nConsumers: ${(consumers ?? []).join(", ")}`;
}

function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  onCancel?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      try { onCancel?.(); } catch { /* best effort */ }
      finish(() => reject(new Error("aborted")));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try { onCancel?.(); } catch { /* best effort */ }
        finish(() => reject(new Error(`timeout after ${timeoutMs}ms`)));
      }, timeoutMs);
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function computeTopology(waves: Wave[]): {
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

function buildResult(
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

function declaredSendsLimit(node: DAGNode): number {
  return Math.min(node.dispatch?.maxChildren ?? DEFAULT_MAX_DISPATCH_CHILDREN, HARD_MAX_DISPATCH_CHILDREN);
}

async function spawnSends(sends: Send[], spawnFn: SpawnFn): Promise<SpawnHandle[]> {
  const settled = await Promise.allSettled(sends.map((send) => spawnFn(
    send.role,
    appendSemanticContract(sendToTask(send), send.expected_output, send.consumers),
  )));
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : {
    agentId: `failed-send-${index}`,
    wait: async () => ({
      status: "failed" as const,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }),
  });
}

async function runNodeWork(
  node: PlannedNode,
  specNode: DAGNode,
  spawnFn: SpawnFn,
  nodeResults: Map<string, NodeResult>,
  knownRoles: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined,
  counters: ExecutionCounters,
): Promise<NodeResult> {
  try {
    let task = appendSemanticContract(node.task, specNode.expected_output, specNode.consumers);
    for (const dep of node.deps) {
      const result = nodeResults.get(dep);
      if (result?.status === "failed") task += errorContextPrefix(dep, result.error ?? "unknown");
    }
    const completedDeps: Record<string, NodePayload> = {};
    for (const dep of node.deps) {
      const result = nodeResults.get(dep);
      if (result?.status === "completed" && result.result) completedDeps[dep] = result.result;
    }
    counters.downstreamResultConsumptionCount += Object.keys(completedDeps).length;
    if (Object.keys(completedDeps).length > 0) task += upstreamResultsPrefix(completedDeps);

    let handles: SpawnHandle[];
    if (node.sends && node.sends.length > 0) {
      if (specNode.dispatch !== undefined && node.sends.length > declaredSendsLimit(specNode)) {
        throw new Error(`declared sends ${node.sends.length} exceed maxChildren=${declaredSendsLimit(specNode)}`);
      }
      counters.dispatchCount += node.sends.length;
      handles = await spawnSends(node.sends, spawnFn);
    } else if (node.dynamic) {
      const dependencies: DynamicNodeContext["dependencies"] = {};
      for (const dep of node.deps) {
        const result = nodeResults.get(dep);
        if (!result) continue;
        dependencies[dep] = result.status === "completed"
          ? { status: "completed", result: result.result }
          : { status: "failed", error: result.error ?? result.status };
      }
      const sends = await node.dynamic({ nodeId: node.id, dependencies });
      const sendErrors = validateGeneratedSends(node.id, sends, hasSemanticContract(specNode), knownRoles);
      if (sendErrors.length > 0) throw new Error(`invalid generated sends: ${sendErrors.join("; ")}`);
      if (specNode.dispatch !== undefined && sends.length > declaredSendsLimit(specNode)) {
        throw new Error(`dynamic sends ${sends.length} exceed maxChildren=${declaredSendsLimit(specNode)}`);
      }
      counters.dispatchCount += sends.length;
      handles = await spawnSends(sends, spawnFn);
    } else {
      const resultDispatchLimit = specNode.dispatch !== undefined && specNode.sends === undefined && specNode.dynamic === undefined
        ? declaredSendsLimit(specNode)
        : undefined;
      handles = [await spawnFn(
        node.role,
        task,
        node.roleDef,
        node.model,
        node.thinkingLevel,
        node.routes,
        resultDispatchLimit,
      )];
    }

    const settled = await Promise.allSettled(handles.map((handle) => handle.wait()));
    const payloads: NodePayload[] = [];
    let error: string | undefined;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value.status === "completed") {
        payloads.push(normalizePayload(outcome.value));
      } else if (outcome.status === "fulfilled") {
        error ??= outcome.value.error ?? outcome.value.status;
      } else {
        error ??= outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      }
    }
    if (error) return { nodeId: node.id, status: "failed", error };
    return { nodeId: node.id, status: "completed", result: mergePayloads(payloads) };
  } catch (error) {
    return { nodeId: node.id, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function runNode(
  node: PlannedNode,
  specNode: DAGNode,
  spawnFn: SpawnFn,
  nodeResults: Map<string, NodeResult>,
  signal: AbortSignal | undefined,
  knownRoles: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined,
  counters: ExecutionCounters,
): Promise<NodeResult> {
  const handles = new Set<SpawnHandle>();
  let cancelled = false;
  const trackedSpawn: SpawnFn = (...args) => Promise.resolve()
    .then(() => spawnFn(...args))
    .then((handle) => {
      if (cancelled) {
        try { handle.abort?.(); } catch { /* best effort */ }
        throw new Error("spawn completed after node cancellation");
      }
      handles.add(handle);
      return handle;
    });
  const cancel = () => {
    cancelled = true;
    for (const handle of handles) {
      try { handle.abort?.(); } catch { /* best effort */ }
    }
  };

  try {
    return await waitForPromise(
      runNodeWork(node, specNode, trackedSpawn, nodeResults, knownRoles, counters),
      node.timeout_ms,
      signal,
      cancel,
    );
  } catch (error) {
    return { nodeId: node.id, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeDAGCore(inputSpec: DAGSpec, spawnFn: SpawnFn, opts: ExecuteOptions = {}): Promise<DAGResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const validation = validateDAG(inputSpec, opts.knownRoles, {
    expandedDispatches: new Set(Object.keys(opts.initialDispatchExpansions ?? {})),
  });
  if (!validation.ok) throw new Error(`invalid DAG: ${validation.errors.join("; ")}`);

  const scheduler: DAGScheduler = opts.scheduler ?? "ready";
  const nodeModes: Record<string, DAGNodeExecutionMode> = opts.initialNodeModes
    ? { ...opts.initialNodeModes }
    : Object.fromEntries(Object.entries(inputSpec.nodes).map(([id, node]) => [id,
      typeof node.dynamic === "function"
        ? "dynamic"
        : node.sends !== undefined
          ? "sends"
          : node.dispatch !== undefined
            ? "result_dispatch"
            : "spawn",
    ]));
  let spec: DAGSpec = { ...inputSpec, nodes: { ...inputSpec.nodes } };
  let generatedNodes: Record<string, GeneratedNodeRecord> = { ...(opts.initialGeneratedNodes ?? {}) };
  const dispatchExpansions: Record<string, DispatchExpansionRecord> = Object.fromEntries(
    Object.entries(opts.initialDispatchExpansions ?? {}).map(([id, record]) => [id, cloneDispatchExpansion(record)]),
  );

  let waves: Wave[] = [];
  let plannedById = new Map<string, PlannedNode>();
  let specOrder = new Map<string, number>();
  let waveByNode = new Map<string, number>();
  let remainingCriticalPath = new Map<string, number>();
  let scopes = new Map<string, string[]>();
  const rebuildTopology = () => {
    waves = planWaves(spec);
    plannedById = new Map(waves.flatMap((wave) => wave.nodes.map((node) => [node.id, node] as const)));
    specOrder = new Map(Object.keys(spec.nodes).map((id, index) => [id, index]));
    ({ waveByNode, remainingCriticalPath } = computeTopology(waves));
    scopes = new Map(Object.entries(spec.nodes).map(([id, node]) => [id, (node.write_scope ?? []).map(normalizeWriteScope)]));
  };
  rebuildTopology();

  const knownIds = new Set(Object.keys(spec.nodes));
  for (const [id, record] of Object.entries(generatedNodes)) {
    if (record.id !== id || !knownIds.has(id) || !knownIds.has(record.parentId)) {
      throw new Error(`invalid generated node metadata for '${id}'`);
    }
  }
  for (const [parentId, expansion] of Object.entries(dispatchExpansions)) {
    if (expansion.parentId !== parentId || !knownIds.has(parentId)) throw new Error(`invalid dispatch expansion '${parentId}'`);
    if (expansion.source === "result" && !expansion.dispatcherResult) {
      throw new Error(`result dispatch expansion '${parentId}' is missing its dispatcher result`);
    }
    for (const childId of expansion.generatedNodeIds) {
      if (generatedNodes[childId]?.parentId !== parentId || !knownIds.has(childId)) {
        throw new Error(`invalid generated child '${childId}' for dispatch '${parentId}'`);
      }
    }
  }

  const requestedConcurrency = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxConcurrent = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.max(1, Math.min(HARD_MAX_CONCURRENT, Math.floor(requestedConcurrency)))
    : DEFAULT_MAX_CONCURRENT;
  const nodeResults = new Map<string, NodeResult>();
  for (const [id, result] of opts.initialNodeResults ?? []) {
    if (!knownIds.has(id)) throw new Error(`initial result references unknown node '${id}'`);
    nodeResults.set(id, result);
  }
  for (const wave of opts.priorWaveResults ?? []) {
    for (const result of [...wave.successes, ...wave.failures, ...(wave.skipped ?? [])]) {
      if (!knownIds.has(result.nodeId)) throw new Error(`prior wave result references unknown node '${result.nodeId}'`);
      if (!nodeResults.has(result.nodeId)) nodeResults.set(result.nodeId, result);
    }
  }
  const states: Record<string, DAGNodeState> = Object.fromEntries(Object.keys(spec.nodes).map((id) => [id, { status: "queued" as const }]));
  for (const [id, prior] of Object.entries(opts.initialNodeStates ?? {})) {
    if (!states[id]) throw new Error(`initial state references unknown node '${id}'`);
    states[id] = isTerminal(prior.status) ? { ...prior } : { status: "queued", readyAt: prior.readyAt };
  }
  for (const [id, result] of nodeResults) {
    states[id] = {
      ...states[id],
      status: result.status,
      error: result.error,
      route: typeof result.result?.route === "string" ? result.result.route : undefined,
    };
  }
  for (const parentId of Object.keys(dispatchExpansions)) {
    if (!isTerminal(states[parentId].status)) states[parentId] = { ...states[parentId], status: "running" };
  }

  const skipReasons = new Map<string, string>(opts.initialSkipReasons ?? []);
  for (const id of skipReasons.keys()) if (!knownIds.has(id)) throw new Error(`skip reason references unknown node '${id}'`);
  const leases = new WriteScopeLeases();
  const running = new Map<string, Promise<void>>();
  let peakConcurrent = 0;
  const counters: ExecutionCounters = { routeCount: 0, dispatchCount: 0, downstreamResultConsumptionCount: 0 };

  const currentWave = (): number => {
    const active = [...running.keys()];
    const queued = Object.keys(states).filter((id) => states[id].status === "queued");
    const candidates = active.length > 0 ? active : queued;
    if (candidates.length === 0) return Math.max(0, waves.length - 1);
    return Math.min(...candidates.map((id) => waveByNode.get(id) ?? 0));
  };
  const emitProgress = (finalResult?: Pick<DAGResult, "status" | "termination">) => {
    const nodes: DAGProgress["nodes"] = {};
    for (const [id, state] of Object.entries(states)) nodes[id] = { status: state.status, error: state.error, route: state.route };
    opts.onProgress?.({
      dagId: "",
      currentWave: currentWave(),
      totalWaves: waves.length,
      scheduler,
      outcome: finalResult?.status,
      termination: finalResult?.termination,
      explicitStates: true,
      nodes,
      expandedSpec: spec,
      generatedNodes: { ...generatedNodes },
    });
  };
  const emitCheckpoint = () => {
    opts.onCheckpoint?.({
      scheduler,
      expandedSpec: spec,
      nodeModes: { ...nodeModes },
      nodeStates: copyStates(states),
      nodeResults: Object.fromEntries([...nodeResults].map(([id, result]) => [id, { ...result }])),
      skipReasons: Object.fromEntries(skipReasons),
      generatedNodes: { ...generatedNodes },
      dispatchExpansions: Object.fromEntries(Object.entries(dispatchExpansions).map(([id, record]) => [id, cloneDispatchExpansion(record)])),
    });
  };

  const applyRoute = (id: string, result: NodeResult): NodeResult => {
    const routes = spec.nodes[id]?.routes;
    if (!routes || result.status !== "completed") return result;
    counters.routeCount++;
    const route = result.result?.route;
    const allTargets = new Set(Object.values(routes).flat());
    if (typeof route !== "string" || route.length === 0) {
      for (const target of allTargets) if (!nodeResults.has(target)) skipReasons.set(target, `routing node '${id}' failed: missing route`);
      return { nodeId: id, status: "failed", error: "missing route in node result" };
    }
    const selected = routes[route];
    if (!selected) {
      for (const target of allTargets) if (!nodeResults.has(target)) skipReasons.set(target, `routing node '${id}' failed: unknown route '${route}'`);
      return { nodeId: id, status: "failed", error: `unknown route '${route}'` };
    }
    const selectedSet = new Set(selected);
    for (const target of allTargets) {
      if (!selectedSet.has(target) && !nodeResults.has(target)) skipReasons.set(target, `route '${route}' from '${id}' did not select '${target}'`);
    }
    return result;
  };

  const settleSkippedNodes = (): boolean => {
    let changed = false;
    for (const [id, reason] of skipReasons) {
      if (states[id]?.status !== "queued") continue;
      const result: NodeResult = { nodeId: id, status: "skipped", error: reason };
      nodeResults.set(id, result);
      states[id] = { ...states[id], status: "skipped", error: reason, finishedAt: now() };
      changed = true;
      emitCheckpoint();
      emitProgress();
    }
    return changed;
  };

  const settleExpandedParents = (): boolean => {
    let changed = false;
    for (const [parentId, expansion] of Object.entries(dispatchExpansions)) {
      if (isTerminal(states[parentId].status)) continue;
      const childStates = expansion.generatedNodeIds.map((id) => states[id]);
      if (!childStates.every((state) => state && isTerminal(state.status))) continue;
      const failedChildId = expansion.generatedNodeIds.find((id) => states[id].status !== "completed");
      const settledAt = now();
      let result: NodeResult;
      if (failedChildId) {
        result = {
          nodeId: parentId,
          status: "failed",
          error: `generated child '${failedChildId}' ${states[failedChildId].status}: ${states[failedChildId].error ?? "no result"}`,
        };
      } else {
        const childPayloads = expansion.generatedNodeIds.map((id) => nodeResults.get(id)?.result).filter((payload): payload is NodePayload => Boolean(payload));
        if (childPayloads.length !== expansion.generatedNodeIds.length) {
          result = { nodeId: parentId, status: "failed", error: "generated child completed without a persisted result" };
        } else {
          const payloads = expansion.dispatcherResult
            ? [expansion.dispatcherResult, ...childPayloads]
            : childPayloads;
          counters.downstreamResultConsumptionCount += payloads.length;
          result = { nodeId: parentId, status: "completed", result: mergePayloads(payloads) };
        }
      }
      nodeResults.set(parentId, result);
      states[parentId] = {
        ...states[parentId],
        status: result.status,
        error: result.error,
        startedAt: states[parentId].startedAt ?? settledAt,
        finishedAt: states[parentId].finishedAt ?? settledAt,
      };
      changed = true;
      emitCheckpoint();
      emitProgress();
    }
    return changed;
  };

  const resolveDispatch = async (id: string, node: DAGNode): Promise<{
    sends: Send[];
    source: DispatchExpansionRecord["source"];
    dispatcherResult?: NodePayload;
  }> => {
    if (node.sends !== undefined) return { sends: node.sends, source: "sends" };
    if (!node.dynamic) {
      const planned = plannedById.get(id);
      if (!planned) throw new Error(`result dispatcher '${id}' is missing from the execution plan`);
      const result = await runNode(planned, node, spawnFn, nodeResults, opts.signal, opts.knownRoles, counters);
      if (result.status !== "completed" || !result.result) {
        throw new Error(result.error ?? `result dispatcher '${id}' did not complete`);
      }
      const sends = result.result.sends;
      if (!Array.isArray(sends)) {
        throw new Error(`result dispatcher '${id}' must return a top-level sends array`);
      }
      return { sends: sends as Send[], source: "result", dispatcherResult: result.result };
    }
    const dependencies: DynamicNodeContext["dependencies"] = {};
    for (const dep of node.depends_on ?? []) {
      const result = nodeResults.get(dep);
      if (!result) continue;
      dependencies[dep] = result.status === "completed"
        ? { status: "completed", result: result.result }
        : { status: "failed", error: result.error ?? result.status };
    }
    return {
      sends: await waitForPromise(node.dynamic({ nodeId: id, dependencies }), node.timeout_ms, opts.signal),
      source: "dynamic",
    };
  };

  const expandDispatch = async (id: string): Promise<void> => {
    const node = spec.nodes[id];
    try {
      const resolved = await resolveDispatch(id, node);
      const sends = resolved.sends;
      const sendErrors = validateGeneratedSends(id, sends, true, opts.knownRoles);
      if (sendErrors.length > 0) throw new Error(`invalid generated sends: ${sendErrors.join("; ")}`);
      if (sends.length > declaredSendsLimit(node)) {
        throw new Error(`generated sends ${sends.length} exceed maxChildren=${declaredSendsLimit(node)}`);
      }
      const persistedSends = sends.map((send) => structuredClone(send));
      const expanded = expandDispatchNode(spec, id, persistedSends, generatedNodes);
      const expandedValidation = validateDAG(expanded.spec, opts.knownRoles, {
        expandedDispatches: new Set([...Object.keys(dispatchExpansions), id]),
      });
      if (!expandedValidation.ok) throw new Error(`expanded DAG is invalid: ${expandedValidation.errors.join("; ")}`);

      spec = expanded.spec;
      generatedNodes = expanded.generatedNodes;
      const childIds = sends.map((send) => generatedNodeId(id, send.key!));
      dispatchExpansions[id] = {
        parentId: id,
        generatedNodeIds: childIds,
        source: resolved.source,
        sends: persistedSends,
        dispatcherResult: resolved.dispatcherResult,
      };
      states[id] = { ...states[id], status: "running", finishedAt: now() };
      for (const childId of childIds) states[childId] = { status: "queued" };
      counters.dispatchCount += childIds.length;
      rebuildTopology();
      emitCheckpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: NodeResult = { nodeId: id, status: "failed", error: message };
      nodeResults.set(id, result);
      states[id] = { ...states[id], status: "failed", error: message, finishedAt: now() };
      emitCheckpoint();
    }
  };

  const launchDispatch = (id: string) => {
    const nodeScopes = scopes.get(id) ?? [];
    if (!leases.acquire(id, nodeScopes)) return false;
    states[id] = { ...states[id], status: "running", startedAt: now(), finishedAt: undefined };
    const promise = expandDispatch(id).finally(() => {
      leases.release(id);
      running.delete(id);
      emitProgress();
    });
    running.set(id, promise);
    peakConcurrent = Math.max(peakConcurrent, running.size);
    emitProgress();
    return true;
  };

  const launch = (id: string) => {
    const planned = plannedById.get(id)!;
    const nodeScopes = scopes.get(id) ?? [];
    if (!leases.acquire(id, nodeScopes)) return false;
    states[id] = { ...states[id], status: "running", startedAt: now() };
    const promise = (async () => {
      let result = await runNode(planned, spec.nodes[id], spawnFn, nodeResults, opts.signal, opts.knownRoles, counters);
      result = applyRoute(id, result);
      nodeResults.set(id, result);
      states[id] = {
        ...states[id],
        status: result.status,
        error: result.error,
        route: typeof result.result?.route === "string" ? result.result.route : undefined,
        finishedAt: now(),
      };
    })().catch((error) => {
      const result: NodeResult = { nodeId: id, status: "failed", error: error instanceof Error ? error.message : String(error) };
      nodeResults.set(id, result);
      states[id] = { ...states[id], status: "failed", error: result.error, finishedAt: now() };
    }).finally(() => {
      leases.release(id);
      running.delete(id);
      emitCheckpoint();
      emitProgress();
    });
    running.set(id, promise);
    peakConcurrent = Math.max(peakConcurrent, running.size);
    emitProgress();
    return true;
  };

  const sortedReady = (): string[] => {
    const activeWave = currentWave();
    const ready = Object.keys(spec.nodes).filter((id) => {
      if (states[id].status !== "queued" || skipReasons.has(id)) return false;
      if (scheduler === "wave" && (waveByNode.get(id) ?? 0) !== activeWave) return false;
      return (spec.nodes[id].depends_on ?? []).every((dep) => isTerminal(states[dep]?.status));
    });
    const becameReadyAt = now();
    for (const id of ready) states[id].readyAt ??= becameReadyAt;
    if (scheduler === "wave") return ready.sort((a, b) => (specOrder.get(a) ?? 0) - (specOrder.get(b) ?? 0));
    return ready.sort((a, b) => {
      const priority = (spec.nodes[b].priority ?? 0) - (spec.nodes[a].priority ?? 0);
      if (priority !== 0) return priority;
      const critical = (remainingCriticalPath.get(b) ?? 1) - (remainingCriticalPath.get(a) ?? 1);
      if (critical !== 0) return critical;
      return (specOrder.get(a) ?? 0) - (specOrder.get(b) ?? 0);
    });
  };

  emitProgress();
  let termination: DAGResult["termination"] = "blocked";
  while (true) {
    settleSkippedNodes();
    settleExpandedParents();
    if (opts.signal?.aborted) {
      termination = "aborted";
      await Promise.allSettled([...running.values()]);
      break;
    }
    if (Object.values(states).every((state) => isTerminal(state.status))) {
      termination = "all_terminal";
      break;
    }

    let dispatched = false;
    for (const id of sortedReady()) {
      if (running.size >= maxConcurrent) break;
      if (!leases.canAcquire(scopes.get(id) ?? [])) continue;
      const node = spec.nodes[id];
      const isDispatch = node.dispatch !== undefined && !dispatchExpansions[id];
      dispatched = (isDispatch ? launchDispatch(id) : launch(id)) || dispatched;
    }
    if (running.size > 0) {
      await Promise.race([...running.values()]);
      continue;
    }
    if (!dispatched) {
      termination = opts.signal?.aborted ? "aborted" : "blocked";
      break;
    }
  }

  const finishedAt = now();
  const result = buildResult(
    spec,
    waves,
    nodeResults,
    states,
    termination,
    peakConcurrent,
    maxConcurrent,
    startedAt,
    finishedAt,
    counters,
    validation.diagnostics,
  );
  emitProgress(result);
  return result;
}

/** Execute a full DAG using the default ready scheduler. */
export async function executeDAG(spec: DAGSpec, spawnFn: SpawnFn): Promise<DAGResult> {
  return executeDAGCore(spec, spawnFn);
}
