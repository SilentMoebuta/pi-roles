import type {
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
  WorkflowLineage,
} from "./types";
import { createHash } from "node:crypto";
import type { DynamicNodeContext, Send } from "./send";
import { planWaves, type PlannedNode, type Wave } from "./planner";
import type { ExecutionCounters, ExecuteOptions, SpawnFn } from "./executor-contract";
import { buildResult, computeTopology } from "./executor-metrics";
import { cloneDispatchExpansion, copyStates, isTerminal, mergePayloads } from "./executor-payload";
import { declaredSendsLimit, runNode, waitForPromise } from "./executor-run";
import { failedNodeResult, nodeErrorMessage } from "./error-taxonomy";
import { validateDAG, validateGeneratedSends } from "./validate";
import { expandDispatchNode, generatedNodeId } from "./expansion";
import { normalizeWriteScope } from "./scope";
import { normalizeResourceUri, ResourceLeases } from "./resource-lease";

export type { ExecuteOptions, SpawnFn, SpawnHandle, SpawnOutcomeStatus } from "./executor-contract";
export { mergePayloads } from "./executor-payload";

export const DEFAULT_MAX_CONCURRENT = 5;
export const HARD_MAX_CONCURRENT = 20;
export async function executeDAGCore(inputSpec: DAGSpec, spawnFn: SpawnFn, opts: ExecuteOptions = {}): Promise<DAGResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const workflow = normalizeWorkflowLineage(inputSpec, opts.workflow, startedAt);
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
    scopes = new Map(Object.entries(spec.nodes).map(([id, node]) => {
      const fileResources = (node.write_scope ?? []).map((scope) => {
        const normalized = normalizeWriteScope(scope);
        return `file://repo${normalized === "." ? "" : "/" + normalized}/**`;
      });
      const resources = (node.resource_scope ?? []).map((resource) => normalizeResourceUri(resource).value);
      return [id, [...fileResources, ...resources]];
    }));
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
  const withNodeLineage = (id: string, result: NodeResult): NodeResult => {
    if (result.resultId && result.lineage?.workflowId === workflow.workflowId) return result;
    const previous = nodeResults.get(id);
    const attemptNumber = result.attemptNumber ?? 1;
    const baseResultId = `${workflow.workflowId}:node:${encodeURIComponent(id)}:result`;
    const resultId = attemptNumber === 1 ? baseResultId : `${baseResultId}:attempt:${attemptNumber}`;
    return {
      ...result,
      resultId,
      lineage: {
        ...workflow,
        nodeId: id,
        parentNodeId: generatedNodes[id]?.parentId ?? null,
        previousResultId: previous?.resultId ?? null,
        attemptNumber,
      },
    };
  };
  const storeNodeResult = (id: string, result: NodeResult): NodeResult => {
    const normalized = withNodeLineage(id, result);
    nodeResults.set(id, normalized);
    return normalized;
  };
  for (const [id, result] of opts.initialNodeResults ?? []) {
    if (!knownIds.has(id)) throw new Error(`initial result references unknown node '${id}'`);
    storeNodeResult(id, result);
  }
  for (const wave of opts.priorWaveResults ?? []) {
    for (const result of [...wave.successes, ...wave.failures, ...(wave.skipped ?? [])]) {
      if (!knownIds.has(result.nodeId)) throw new Error(`prior wave result references unknown node '${result.nodeId}'`);
      if (!nodeResults.has(result.nodeId)) storeNodeResult(result.nodeId, result);
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
      errorInfo: result.errorInfo,
      attemptNumber: result.attemptNumber,
      route: typeof result.result?.route === "string" ? result.result.route : undefined,
    };
  }
  for (const parentId of Object.keys(dispatchExpansions)) {
    if (!isTerminal(states[parentId].status)) states[parentId] = { ...states[parentId], status: "running" };
  }

  const skipReasons = new Map<string, string>(opts.initialSkipReasons ?? []);
  for (const id of skipReasons.keys()) if (!knownIds.has(id)) throw new Error(`skip reason references unknown node '${id}'`);
  const leases = new ResourceLeases();
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
      dagId: workflow.workflowId,
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
      workflow,
      scheduler,
      expandedSpec: spec,
      nodeModes: { ...nodeModes },
      nodeStates: copyStates(states),
      nodeResults: Object.fromEntries([...nodeResults].map(([id, result]) => [id, { ...result }])),
      skipReasons: Object.fromEntries(skipReasons),
      generatedNodes: { ...generatedNodes },
      dispatchExpansions: Object.fromEntries(Object.entries(dispatchExpansions).map(([id, record]) => [id, cloneDispatchExpansion(record)])),
      artifactDigests: structuredClone(opts.checkpointRuntime?.artifactDigests ?? {}),
      approvals: structuredClone(opts.checkpointRuntime?.approvals ?? {}),
      sideEffectJournal: structuredClone(opts.checkpointRuntime?.sideEffectJournal ?? {}),
    });
  };

  const retryPolicy = {
    maxAttempts: Math.max(1, Math.floor(opts.retryPolicy?.maxAttempts ?? 1)),
    baseDelayMs: Math.max(0, Math.floor(opts.retryPolicy?.baseDelayMs ?? 10_000)),
    maxDelayMs: Math.max(0, Math.floor(opts.retryPolicy?.maxDelayMs ?? 120_000)),
  };
  const runNodeWithRetry = async (planned: PlannedNode, node: DAGNode): Promise<NodeResult> => {
    for (let attemptNumber = 1; attemptNumber <= retryPolicy.maxAttempts; attemptNumber++) {
      opts.onAttempt?.({ nodeId: planned.id, attemptNumber, status: "started" });
      const raw = await runNode(planned, node, spawnFn, nodeResults, opts.signal, opts.knownRoles, counters);
      const result = { ...raw, attemptNumber };
      if (result.status === "completed") {
        opts.onAttempt?.({ nodeId: planned.id, attemptNumber, status: "completed" });
        return result;
      }
      const errorInfo = result.errorInfo ?? failedNodeResult(planned.id, result.error ?? result.status).errorInfo!;
      const normalized = { ...result, error: errorInfo.message, errorInfo };
      if (!errorInfo.retryable || attemptNumber >= retryPolicy.maxAttempts || opts.signal?.aborted) {
        opts.onAttempt?.({ nodeId: planned.id, attemptNumber, status: "failed", error: errorInfo });
        return normalized;
      }
      const delayMs = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * (2 ** Math.max(0, attemptNumber - 1)));
      opts.onAttempt?.({ nodeId: planned.id, attemptNumber, status: "retrying", error: errorInfo, delayMs });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (opts.signal?.aborted) return failedNodeResult(planned.id, "aborted", { status: "aborted", attemptNumber });
    }
    return failedNodeResult(planned.id, "retry policy exhausted");
  };

  const applyRoute = (id: string, result: NodeResult): NodeResult => {
    const routes = spec.nodes[id]?.routes;
    if (!routes || result.status !== "completed") return result;
    counters.routeCount++;
    const route = result.result?.route;
    const allTargets = new Set(Object.values(routes).flat());
    if (typeof route !== "string" || route.length === 0) {
      for (const target of allTargets) if (!nodeResults.has(target)) skipReasons.set(target, `routing node '${id}' failed: missing route`);
      return failedNodeResult(id, "missing route in node result");
    }
    const selected = routes[route];
    if (!selected) {
      for (const target of allTargets) if (!nodeResults.has(target)) skipReasons.set(target, `routing node '${id}' failed: unknown route '${route}'`);
      return failedNodeResult(id, `unknown route '${route}'`);
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
      storeNodeResult(id, result);
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
          result = failedNodeResult(parentId, "generated child completed without a persisted result");
        } else {
          const payloads = expansion.dispatcherResult
            ? [expansion.dispatcherResult, ...childPayloads]
            : childPayloads;
          counters.downstreamResultConsumptionCount += payloads.length;
          result = { nodeId: parentId, status: "completed", result: mergePayloads(payloads) };
        }
      }
      storeNodeResult(parentId, result);
      states[parentId] = {
        ...states[parentId],
        status: result.status,
        error: result.error,
        errorInfo: result.errorInfo,
        attemptNumber: result.attemptNumber,
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
      const result = await runNodeWithRetry(planned, node);
      if (result.status !== "completed" || !result.result) {
        throw new Error(nodeErrorMessage(result) || `result dispatcher '${id}' did not complete`);
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
        : { status: "failed", error: nodeErrorMessage(result) };
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
      const result = failedNodeResult(id, error);
      storeNodeResult(id, result);
      states[id] = { ...states[id], status: "failed", error: result.error, errorInfo: result.errorInfo, attemptNumber: result.attemptNumber, finishedAt: now() };
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
      let result = await runNodeWithRetry(planned, spec.nodes[id]);
      result = applyRoute(id, result);
      result = storeNodeResult(id, result);
      states[id] = {
        ...states[id],
        status: result.status,
        error: result.error,
        errorInfo: result.errorInfo,
        attemptNumber: result.attemptNumber,
        route: typeof result.result?.route === "string" ? result.result.route : undefined,
        finishedAt: now(),
      };
    })().catch((error) => {
      const result = failedNodeResult(id, error);
      storeNodeResult(id, result);
      states[id] = { ...states[id], status: "failed", error: result.error, errorInfo: result.errorInfo, attemptNumber: result.attemptNumber, finishedAt: now() };
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
    workflow,
  );
  emitProgress(result);
  return result;
}

/** Execute a full DAG using the default ready scheduler. */
export async function executeDAG(spec: DAGSpec, spawnFn: SpawnFn): Promise<DAGResult> {
  return executeDAGCore(spec, spawnFn);
}

function normalizeWorkflowLineage(
  spec: DAGSpec,
  supplied: Partial<WorkflowLineage> | undefined,
  startedAt: number,
): WorkflowLineage {
  const source = { ...(spec.lineage ?? {}), ...(supplied ?? {}) };
  const structuralDigest = createHash("sha256").update(JSON.stringify(spec.nodes)).digest("hex").slice(0, 16);
  return {
    workflowId: nonEmpty(source.workflowId) ?? `dag:${structuralDigest}:${startedAt}`,
    goalDefinitionId: nullableIdentity(source.goalDefinitionId),
    revisionId: nullableIdentity(source.revisionId),
    runId: nullableIdentity(source.runId),
    attemptId: nullableIdentity(source.attemptId),
    parentWorkflowId: nullableIdentity(source.parentWorkflowId),
    previousWorkflowId: nullableIdentity(source.previousWorkflowId),
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableIdentity(value: unknown): string | null {
  return nonEmpty(value) ?? null;
}
