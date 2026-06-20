// Phase 5b/5d types — DAG spec, wave/node results, error context, aggregate result.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md.

export interface DAGNode {
  role: string;
  task: string;
  depends_on?: string[];
}

export interface DAGSpec {
  nodes: Record<string, DAGNode>;
}

export interface NodePayload {
  findings: string[];
  artifacts: string[];
}

export interface NodeResult {
  nodeId: string;
  status: "completed" | "failed";
  result?: NodePayload;
  error?: string;
}

export interface WaveResult {
  wave: number;
  successes: NodeResult[];
  failures: NodeResult[];
}

// Reserved for structured error typing (5d design). The executor currently
// propagates predecessor failures via the string errorContextPrefix() in
// state.ts; this structured type is the future shape for Send/checkpoint (5c/5e,// deferred) and is kept here so the public surface is stable.
export interface ErrorContext {
  failedNode: string;
  errorType: "step-limit" | "caller-abort" | "timeout" | "runtime-error";
  errorMessage: string;
}

export interface DAGResult {
  status: "completed" | "partial" | "failed";
  waves: WaveResult[];
  finalContext: Record<string, NodePayload>;
}
