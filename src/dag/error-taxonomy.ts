import type { DAGErrorCode, DAGNodeError, NodeResult } from "./types";
import type { SpawnOutcomeStatus } from "./executor-contract";

const POLICY: Record<DAGErrorCode, Pick<DAGNodeError, "retryable" | "recovery">> = {
  rate_limit: { retryable: true, recovery: "retry_attempt" },
  capacity: { retryable: true, recovery: "retry_attempt" },
  network: { retryable: true, recovery: "retry_attempt" },
  provider_abort: { retryable: true, recovery: "retry_attempt" },
  worker_crash: { retryable: true, recovery: "retry_attempt" },
  timeout: { retryable: true, recovery: "retry_attempt" },
  schema_invalid: { retryable: false, recovery: "repair_schema" },
  verification_failed: { retryable: false, recovery: "revise" },
  policy_denied: { retryable: false, recovery: "stop" },
  approval_required: { retryable: false, recovery: "wait_approval" },
  budget_exhausted: { retryable: false, recovery: "wait_user" },
  cancelled: { retryable: false, recovery: "stop" },
  internal: { retryable: false, recovery: "stop" },
};

export function createDAGNodeError(
  code: DAGErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DAGNodeError {
  return { code, message, ...POLICY[code], ...(details === undefined ? {} : { details }) };
}

export function classifyDAGError(value: unknown, status?: SpawnOutcomeStatus): DAGNodeError {
  if (isDAGNodeError(value)) return value;
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(object.message ?? value ?? status ?? "unknown error");
  const statusCode = typeof object.status === "number" ? object.status
    : typeof object.statusCode === "number" ? object.statusCode : undefined;
  const text = `${String(object.code ?? "")} ${message}`.toLowerCase();
  let code: DAGErrorCode = "internal";
  if (statusCode === 429 || /\b429\b|rate.?limit|too many requests/.test(text)) code = "rate_limit";
  else if (statusCode === 503 || /capacity|overload|resource exhausted|no slots?/.test(text)) code = "capacity";
  else if (/timeout|timed out|etimedout/.test(text)) code = "timeout";
  else if (/network|econnreset|econnrefused|enotfound|socket|fetch failed/.test(text)) code = "network";
  else if (/provider.?abort|upstream.?abort/.test(text)) code = "provider_abort";
  else if (/worker.*(?:crash|exit)|child process.*exit|worker_crash/.test(text) || status === "error") code = "worker_crash";
  else if (/schema|invalid json|structured output/.test(text)) code = "schema_invalid";
  else if (/verification|test failed|check failed/.test(text)) code = "verification_failed";
  else if (/approval.*required|requires approval/.test(text)) code = "approval_required";
  else if (/permission|policy.*denied|not allowed|forbidden/.test(text)) code = "policy_denied";
  else if (/budget|quota exhausted/.test(text)) code = "budget_exhausted";
  else if (status === "aborted" || /\baborted\b|cancelled|canceled/.test(text)) code = "cancelled";
  return createDAGNodeError(code, message, statusCode === undefined ? undefined : { status: statusCode });
}

export function failedNodeResult(nodeId: string, value: unknown, options: { status?: SpawnOutcomeStatus; attemptNumber?: number } = {}): NodeResult {
  const errorInfo = classifyDAGError(value, options.status);
  return {
    nodeId,
    status: "failed",
    error: errorInfo.message,
    errorInfo,
    attemptNumber: options.attemptNumber ?? 1,
  };
}

export function nodeErrorMessage(result: Pick<NodeResult, "error" | "errorInfo" | "status">): string {
  return result.errorInfo?.message ?? result.error ?? result.status;
}

export function isDAGNodeError(value: unknown): value is DAGNodeError {
  if (!value || typeof value !== "object") return false;
  const object = value as Partial<DAGNodeError>;
  return typeof object.code === "string" && typeof object.message === "string"
    && typeof object.retryable === "boolean" && typeof object.recovery === "string";
}
