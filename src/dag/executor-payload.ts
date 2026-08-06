import type { DAGNodeState, DispatchExpansionRecord, NodePayload } from "./types";
import type { SpawnOutcome } from "./executor-contract";

export function cloneDispatchExpansion(record: DispatchExpansionRecord): DispatchExpansionRecord {
  return {
    ...record,
    generatedNodeIds: [...record.generatedNodeIds],
    sends: record.sends.map((send) => structuredClone(send)),
    dispatcherResult: record.dispatcherResult ? structuredClone(record.dispatcherResult) : undefined,
  };
}

export function isTerminal(status: DAGNodeState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export function copyStates(states: Record<string, DAGNodeState>): Record<string, DAGNodeState> {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { ...state }]));
}

export function normalizePayload(outcome: SpawnOutcome): NodePayload {
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
