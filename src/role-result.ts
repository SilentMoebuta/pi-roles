import { createHash } from "node:crypto";
import type { ReportPayload } from "./contract";

export const PI_ROLES_RESULT_TYPE = "pi-roles:role-result";
export const ROLE_RESULT_SCHEMA_VERSION = 1 as const;

export type RoleResultStatus = "completed" | "aborted" | "error";
export type RoleErrorCode =
  | "provider_abort"
  | "step_limit"
  | "doom_loop"
  | "liveness"
  | "tool_timeout"
  | "caller_abort"
  | "schema_invalid"
  | "worker_error"
  | "unknown";

export interface RoleExecutionError {
  code: RoleErrorCode;
  message: string;
  retryable: boolean;
}

export interface RoleResultRef {
  resultId: string;
  agentId: string;
  role: string;
  status: RoleResultStatus;
  digest: string;
}

export interface RoleResultEnvelopeV1 extends RoleResultRef {
  schemaVersion: typeof ROLE_RESULT_SCHEMA_VERSION;
  payload: ReportPayload | null;
  error: RoleExecutionError | null;
  turnCount: number;
  recordedAt: number;
}

export interface CreateRoleResultEnvelopeInput {
  agentId: string;
  role: string;
  status: string;
  payload?: ReportPayload;
  error?: string;
  reason?: string;
  turnCount?: number;
  recordedAt?: number;
}

export function createRoleResultEnvelope(input: CreateRoleResultEnvelopeInput): RoleResultEnvelopeV1 {
  const agentId = requiredString(input.agentId, "agentId");
  const role = requiredString(input.role, "role");
  const status = normalizeStatus(input.status);
  const payload = input.payload === undefined ? null : cloneJson(input.payload);
  const error = status === "completed" ? null : roleError(input.reason, input.error);
  const recordedAt = input.recordedAt ?? Date.now();
  if (!Number.isFinite(recordedAt) || recordedAt < 0) throw new Error("recordedAt must be non-negative");
  const turnCount = input.turnCount ?? 0;
  if (!Number.isInteger(turnCount) || turnCount < 0) throw new Error("turnCount must be a non-negative integer");
  const resultId = `role-result:${agentId}`;
  const digest = payloadDigest({ agentId, role, status, payload, error, turnCount });
  return {
    schemaVersion: ROLE_RESULT_SCHEMA_VERSION,
    resultId,
    agentId,
    role,
    status,
    digest,
    payload,
    error,
    turnCount,
    recordedAt,
  };
}

export function roleResultRef(envelope: RoleResultEnvelopeV1): RoleResultRef {
  return {
    resultId: envelope.resultId,
    agentId: envelope.agentId,
    role: envelope.role,
    status: envelope.status,
    digest: envelope.digest,
  };
}

export function parseRoleResultEnvelope(value: unknown): RoleResultEnvelopeV1 {
  const object = asRecord(value, "role result");
  if (object.schemaVersion !== ROLE_RESULT_SCHEMA_VERSION) throw new Error("role result schemaVersion must be 1");
  const status = normalizeStatus(requiredString(object.status, "status"));
  const payload = object.payload === null ? null : cloneJson(asRecord(object.payload, "payload"));
  const error = object.error === null ? null : parseRoleError(object.error);
  const envelope: RoleResultEnvelopeV1 = {
    schemaVersion: ROLE_RESULT_SCHEMA_VERSION,
    resultId: requiredString(object.resultId, "resultId"),
    agentId: requiredString(object.agentId, "agentId"),
    role: requiredString(object.role, "role"),
    status,
    digest: requiredDigest(object.digest, "digest"),
    payload,
    error,
    turnCount: nonNegativeInteger(object.turnCount, "turnCount"),
    recordedAt: nonNegativeNumber(object.recordedAt, "recordedAt"),
  };
  if (envelope.resultId !== `role-result:${envelope.agentId}`) throw new Error("role resultId does not match agentId");
  if ((status === "completed") !== (error === null)) throw new Error("completed role results must have no error; failed results must have one");
  const expected = payloadDigest({
    agentId: envelope.agentId,
    role: envelope.role,
    status: envelope.status,
    payload: envelope.payload,
    error: envelope.error,
    turnCount: envelope.turnCount,
  });
  if (envelope.digest !== expected) throw new Error("role result digest mismatch");
  return envelope;
}

export function verifyRoleResultRef(envelope: RoleResultEnvelopeV1, ref: RoleResultRef): boolean {
  return envelope.resultId === ref.resultId
    && envelope.agentId === ref.agentId
    && envelope.role === ref.role
    && envelope.status === ref.status
    && envelope.digest === ref.digest;
}

function roleError(reason: string | undefined, message: string | undefined): RoleExecutionError {
  const normalized = reason ?? message ?? "unknown";
  const code: RoleErrorCode = normalized === "provider-abort" ? "provider_abort"
    : normalized === "step-limit" ? "step_limit"
    : normalized === "doom-loop" ? "doom_loop"
    : normalized === "liveness" ? "liveness"
    : normalized === "tool-timeout" ? "tool_timeout"
    : normalized === "caller-abort" ? "caller_abort"
    : normalized.includes("schema") ? "schema_invalid"
    : message ? "worker_error" : "unknown";
  return {
    code,
    message: message ?? reason ?? "Role execution failed.",
    retryable: code === "provider_abort" || code === "liveness" || code === "tool_timeout",
  };
}

function parseRoleError(value: unknown): RoleExecutionError {
  const object = asRecord(value, "error");
  const codes: RoleErrorCode[] = [
    "provider_abort", "step_limit", "doom_loop", "liveness", "tool_timeout", "caller_abort",
    "schema_invalid", "worker_error", "unknown",
  ];
  const code = requiredString(object.code, "error.code") as RoleErrorCode;
  if (!codes.includes(code)) throw new Error("unknown role error code");
  if (typeof object.retryable !== "boolean") throw new Error("error.retryable must be boolean");
  return { code, message: requiredString(object.message, "error.message"), retryable: object.retryable };
}

function normalizeStatus(value: string): RoleResultStatus {
  if (value === "completed") return "completed";
  if (value === "aborted") return "aborted";
  if (value === "error" || value === "failed") return "error";
  throw new Error(`unsupported role result status: ${value}`);
}

function payloadDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requiredDigest(value: unknown, path: string): string {
  const digest = requiredString(value, path);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${path} must be a sha256 digest`);
  return digest;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} must be non-negative`);
  return value;
}
