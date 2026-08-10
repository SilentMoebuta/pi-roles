import type { DAGNode, NodePayload, NodeResult } from "./types";
import type { PlannedNode } from "./planner";
import { errorContextPrefix, upstreamResultsPrefix } from "./state";
import type { DynamicNodeContext } from "./send";
import { sendToTask, type Send } from "./send";
import type { ExecutionCounters, SpawnFn, SpawnHandle } from "./executor-contract";
import { mergePayloads, normalizePayload } from "./executor-payload";
import { classifyDAGError, failedNodeResult, nodeErrorMessage } from "./error-taxonomy";
import {
  DEFAULT_MAX_DISPATCH_CHILDREN,
  HARD_MAX_DISPATCH_CHILDREN,
  hasSemanticContract,
  validateGeneratedSends,
} from "./validate";

function appendSemanticContract(
  task: string,
  expectedOutput: string | undefined,
  consumers: string[] | undefined,
): string {
  if (expectedOutput === undefined && consumers === undefined) return task;
  return `${task}\n\n[Semantic output contract]\nExpected output: ${expectedOutput?.trim() ?? ""}\nConsumers: ${(consumers ?? []).join(", ")}`;
}

export function waitForPromise<T>(
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

export function declaredSendsLimit(node: DAGNode): number {
  return Math.min(node.dispatch?.maxChildren ?? DEFAULT_MAX_DISPATCH_CHILDREN, HARD_MAX_DISPATCH_CHILDREN);
}

async function spawnSends(sends: Send[], spawnFn: SpawnFn): Promise<SpawnHandle[]> {
  const settled = await Promise.allSettled(sends.map((send) => spawnFn(
    send.role,
    appendSemanticContract(sendToTask(send), send.expected_output, send.consumers),
  )));
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : {
    agentId: `failed-send-${index}`,
    wait: async () => {
      const errorInfo = classifyDAGError(result.reason);
      return { status: "failed" as const, error: errorInfo.message, errorInfo };
    },
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
      if (result?.status === "failed") task += errorContextPrefix(dep, nodeErrorMessage(result));
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
          : { status: "failed", error: nodeErrorMessage(result) };
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
    let errorInfo: ReturnType<typeof classifyDAGError> | undefined;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value.status === "completed") {
        payloads.push(normalizePayload(outcome.value));
      } else if (outcome.status === "fulfilled") {
        errorInfo ??= outcome.value.errorInfo ?? classifyDAGError(outcome.value.error ?? outcome.value.status, outcome.value.status);
      } else {
        errorInfo ??= classifyDAGError(outcome.reason);
      }
    }
    if (errorInfo) return { nodeId: node.id, status: "failed", error: errorInfo.message, errorInfo };
    return { nodeId: node.id, status: "completed", result: mergePayloads(payloads), attemptNumber: 1 };
  } catch (error) {
    return failedNodeResult(node.id, error);
  }
}

export async function runNode(
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
    return failedNodeResult(node.id, error);
  }
}
