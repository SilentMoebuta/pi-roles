import { ResourceLeases, normalizeResourceUri } from "./resource-lease";

export const BATCH_MANIFEST_VERSION = 1 as const;

export interface BatchTaskV1<TSpec = unknown> {
  id: string;
  spec: TSpec;
  runId: string;
  attemptId: string;
  resourceScopes?: string[];
}

export interface BatchManifestV1<TSpec = unknown> {
  schemaVersion: typeof BATCH_MANIFEST_VERSION;
  id: string;
  tasks: BatchTaskV1<TSpec>[];
  maxConcurrent: number;
}

export interface BatchTaskResultV1<T = unknown> {
  taskId: string;
  runId: string;
  attemptId: string;
  status: "completed" | "failed" | "cancelled";
  value?: T;
  error?: { code: string; message: string; retryable: boolean };
}

export interface BatchAggregateResultV1<T = unknown> {
  batchId: string;
  status: "completed" | "partial" | "failed";
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  results: BatchTaskResultV1<T>[];
}

export interface BatchExecutionOptionsV1<T = unknown> {
  mode?: "all" | "failed_only";
  prior?: BatchAggregateResultV1<T>;
  signal?: AbortSignal;
}

export type BatchTaskExecutorV1<TSpec, T> = (
  task: BatchTaskV1<TSpec>,
) => Promise<Pick<BatchTaskResultV1<T>, "status" | "value" | "error">>;

export function validateBatchManifest(manifest: BatchManifestV1): string[] {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") return ["batch manifest must be an object"];
  if (manifest.schemaVersion !== BATCH_MANIFEST_VERSION) errors.push(`schemaVersion must be ${BATCH_MANIFEST_VERSION}`);
  if (typeof manifest.id !== "string" || !manifest.id.trim()) errors.push("batch id is required");
  if (!Number.isInteger(manifest.maxConcurrent) || manifest.maxConcurrent < 1) errors.push("maxConcurrent must be a positive integer");
  if (!Array.isArray(manifest.tasks)) return [...errors, "batch tasks must be an array"];
  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    if (!task || typeof task !== "object") { errors.push("batch task must be an object"); continue; }
    if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id)) errors.push(`task id '${task.id ?? ""}' is empty or duplicated`);
    ids.add(task.id);
    if (typeof task.runId !== "string" || typeof task.attemptId !== "string" || !task.runId.trim() || !task.attemptId.trim()) errors.push(`task '${task.id ?? ""}' requires runId and attemptId`);
    for (const resource of task.resourceScopes ?? []) {
      try { normalizeResourceUri(resource); }
      catch (error) { errors.push(`task '${task.id}' has invalid resource scope: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return errors;
}

export function selectBatchTasks<TSpec>(
  manifest: BatchManifestV1<TSpec>,
  prior: BatchAggregateResultV1 | undefined,
  mode: "all" | "failed_only",
): BatchTaskV1<TSpec>[] {
  const errors = validateBatchManifest(manifest);
  if (errors.length > 0) throw new Error(`invalid batch manifest: ${errors.join("; ")}`);
  if (mode === "all" || !prior) return manifest.tasks.map((task) => structuredClone(task));
  validatePriorResult(manifest, prior);
  const priorById = new Map(prior.results.map((result) => [result.taskId, result]));
  return manifest.tasks.flatMap((task) => {
    const result = priorById.get(task.id);
    if (result?.status !== "failed" || result.error?.retryable === false) return [];
    return [{ ...structuredClone(task), attemptId: nextAttemptId(result.attemptId) }];
  });
}

export function aggregateBatchResults<T>(batchId: string, results: BatchTaskResultV1<T>[]): BatchAggregateResultV1<T> {
  const completed = results.filter((result) => result.status === "completed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const cancelled = results.filter((result) => result.status === "cancelled").length;
  return {
    batchId,
    status: failed === 0 && cancelled === 0 ? "completed" : completed > 0 ? "partial" : "failed",
    total: results.length,
    completed,
    failed,
    cancelled,
    results: structuredClone(results),
  };
}

/** Execute independent logical runs with bounded concurrency and resource leases. */
export async function executeBatchManifest<TSpec, T>(
  manifest: BatchManifestV1<TSpec>,
  execute: BatchTaskExecutorV1<TSpec, T>,
  options: BatchExecutionOptionsV1<T> = {},
): Promise<BatchAggregateResultV1<T>> {
  const selected = selectBatchTasks(manifest, options.prior, options.mode ?? "all");
  const pending = [...selected];
  const leases = new ResourceLeases();
  const active = new Map<string, Promise<{ owner: string; result: BatchTaskResultV1<T> }>>();
  const current: BatchTaskResultV1<T>[] = [];

  const launch = (task: BatchTaskV1<TSpec>): void => {
    const owner = `${manifest.id}/${task.id}/${task.attemptId}`;
    const resources = task.resourceScopes ?? [];
    if (!leases.acquire(owner, resources)) return;
    const promise = Promise.resolve()
      .then(() => execute(structuredClone(task)))
      .then((result): BatchTaskResultV1<T> => ({
        taskId: task.id,
        runId: task.runId,
        attemptId: task.attemptId,
        ...result,
      }))
      .catch((error): BatchTaskResultV1<T> => ({
        taskId: task.id,
        runId: task.runId,
        attemptId: task.attemptId,
        status: "failed",
        error: { code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false },
      }))
      .then((result) => ({ owner, result }));
    active.set(owner, promise);
  };

  while (pending.length > 0 || active.size > 0) {
    if (options.signal?.aborted) {
      for (const task of pending.splice(0)) current.push({
        taskId: task.id,
        runId: task.runId,
        attemptId: task.attemptId,
        status: "cancelled",
        error: { code: "cancelled", message: "batch execution aborted", retryable: false },
      });
    }
    let launched = false;
    for (let index = 0; index < pending.length && active.size < manifest.maxConcurrent;) {
      const task = pending[index];
      const owner = `${manifest.id}/${task.id}/${task.attemptId}`;
      if (leases.canAcquire(task.resourceScopes ?? [])) {
        pending.splice(index, 1);
        launch(task);
        launched = active.has(owner) || launched;
      } else index++;
    }
    if (active.size === 0) {
      if (pending.length > 0 && !launched) throw new Error("batch scheduler could not acquire resources for pending tasks");
      continue;
    }
    const settled = await Promise.race(active.values());
    active.delete(settled.owner);
    leases.release(settled.owner);
    current.push(settled.result);
  }

  const merged = mergeBatchResults(manifest, options.prior, current, options.mode ?? "all");
  return aggregateBatchResults(manifest.id, merged);
}

function mergeBatchResults<TSpec, T>(
  manifest: BatchManifestV1<TSpec>,
  prior: BatchAggregateResultV1<T> | undefined,
  current: BatchTaskResultV1<T>[],
  mode: "all" | "failed_only",
): BatchTaskResultV1<T>[] {
  const byId = new Map<string, BatchTaskResultV1<T>>();
  if (mode === "failed_only" && prior) for (const result of prior.results) byId.set(result.taskId, structuredClone(result));
  for (const result of current) byId.set(result.taskId, structuredClone(result));
  return manifest.tasks.flatMap((task) => {
    const result = byId.get(task.id);
    return result ? [result] : [];
  });
}

function validatePriorResult<TSpec>(manifest: BatchManifestV1<TSpec>, prior: BatchAggregateResultV1): void {
  if (prior.batchId !== manifest.id) throw new Error(`prior batch '${prior.batchId}' does not match manifest '${manifest.id}'`);
  const manifestIds = new Set(manifest.tasks.map((task) => task.id));
  const seen = new Set<string>();
  for (const result of prior.results) {
    if (!manifestIds.has(result.taskId)) throw new Error(`prior result contains unknown task '${result.taskId}'`);
    if (seen.has(result.taskId)) throw new Error(`prior result duplicates task '${result.taskId}'`);
    seen.add(result.taskId);
  }
}

function nextAttemptId(id: string): string {
  const match = id.match(/^(.*:attempt:)(\d+)$/);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${id}:retry:1`;
}
