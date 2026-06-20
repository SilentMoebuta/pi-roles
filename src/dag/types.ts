// Phase 5b/5d types — DAG spec, wave/node results, error context, aggregate result.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md.

export interface DAGNode {
  role: string;
  task: string;
  depends_on?: string[];
  /** Phase 5c: if set, this node is a DynamicNode — instead of a fixed
   *  {role, task}, it returns Send[] at runtime and the executor fans those
   *  out as parallel spawns within the wave. The static role/task are ignored
   *  when dynamic is set. */
  dynamic?: import("./send").DynamicNode;
  /** SOTA gap #3: serializable Send[] — closure-free, JSON-safe alternative to
   *  `dynamic`. When present (and `dynamic` is absent), the executor fans out
   *  these sends directly (no closure invocation). Survives checkpoint
   *  serialize/deserialize (unlike closures). Mirrors the SOTA pattern
   *  (LangGraph `Send` value-objects, Codex CSV-driven fan-out). */
  sends?: import("./send").Send[];
  /** SOTA gap #1: per-node timeout in milliseconds. If the node's wait
   *  takes longer than this, it is marked failed with errorType:"timeout"
   *  (LangGraph/OpenCode/Claude/Codex all have equivalents). */
  timeout_ms?: number;
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

/** Observability (Gap P3): emitted at wave start + per-node settle. */
export interface DAGProgress {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  nodes: Record<string, { status: "queued" | "running" | "completed" | "failed"; error?: string }>;
}
