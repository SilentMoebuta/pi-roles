// Phase 5b/5d types — DAG spec, wave/node results, error context, aggregate result.
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md.

import type { InlineRoleDef } from "../subagent/spawn-role-tool";

export interface DAGNode {
  /** Optional role. When omitted, the executor spawns a default subagent
   *  that inherits the full tool set with no persona/skill injection — useful
   *  for simple tasks that don't need a specialized role. Mixed DAGs (some
   *  nodes with role, some without) are allowed. */
  role?: string;
  /** Inline role definition for ad-hoc expert dispatch (cce V4-style dynamic
   *  experts). Mutually exclusive with `role`. When set, the executor builds
   *  an ad-hoc RoleDef (no disk file, no skills) and spawns it directly —
   *  bypassing the role registry. Safe defaults: canSpawn=false, skills=[]. */
  roleDef?: InlineRoleDef;
  task: string;
  /** Concrete artifact, decision, analysis, or verified state this node must
   *  produce. `expected_output` and `consumers` form an opt-in V2 semantic
   *  contract: when either is declared, both are required and validated. */
  expected_output?: string;
  /** Direct node ids that consume this node's output. Leaf nodes use the
   *  reserved `$result` consumer. Kept optional so existing DAGSpec values
   *  remain valid for one compatibility cycle. */
  consumers?: string[];
  /** Per-node model override (e.g. 'deepseek/deepseek-v4-flash'). Wins over
   *  role.frontmatter model + roleDef.model. Service-mode: caller passes
   *  --model X and main agent threads X to every node. Omit → role/default. */
  model?: string;
  /** Per-node thinkingLevel override ('low'|'medium'|'high'|'xhigh'|'off').
   *  'off' disables thinking for speed on cheap nodes. Wins over role's. */
  thinkingLevel?: string;
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
  /** Higher values are dispatched first when scheduler="ready". Equal-priority
   *  nodes are ordered by remaining critical path, then declaration order. */
  priority?: number;
  /** Repo-relative paths this node may write. Ready scheduling will not run two
   *  nodes with overlapping declared scopes at the same time. Omitted scopes
   *  preserve legacy behavior and do not acquire a lease. */
  write_scope?: string[];
  /** Generic hierarchical resource URIs, for example file://repo/docs/**,
   * worktree://repo/feature-a, or mailbox://ops/customer-42. */
  resource_scope?: string[];
  /** Bounds a fan-out. With `sends` this expands declared data, with `dynamic`
   *  it invokes the legacy in-process callback, and with neither it spawns this
   *  node as a dispatcher whose structured result must contain `sends`. */
  dispatch?: {
    maxChildren?: number;
  };
  /** B-class dynamic routing: node result payload must contain `route`, which
   *  selects one key from this whitelist. Selected target nodes run; unselected
   *  targets are marked skipped. Targets must be downstream dependents. */
  routes?: Record<string, string[]>;
}

export interface DAGSpec {
  nodes: Record<string, DAGNode>;
  /** Optional Goal Contract lineage. The tool adapter supplies workflowId when
   * omitted; goal fields let pi-goal correlate DAG nodes without coupling the
   * pi-roles runtime to pi-goal state storage. */
  lineage?: Partial<WorkflowLineage>;
  /** @deprecated DAG topology depth is not subagent nesting depth. Retained only
   *  for input compatibility and intentionally ignored by the executor. */
  maxDepth?: number;
}

export type DAGScheduler = "wave" | "ready";

/** Serializable origin of an original DAG node. Generated children are
 * always ordinary spawns and are intentionally omitted from this map. */
export type DAGNodeExecutionMode = "spawn" | "sends" | "dynamic" | "result_dispatch";

export type DAGNodeStatus = "queued" | "running" | "completed" | "failed" | "skipped";

export interface DAGNodeState {
  status: DAGNodeStatus;
  error?: string;
  /** Typed error for new checkpoints; `error` remains the display projection. */
  errorInfo?: DAGNodeError;
  attemptNumber?: number;
  route?: string;
  /** First time this node became dependency-ready in the current execution. */
  readyAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface NodePayload {
  findings: string[];
  artifacts: string[];
  [k: string]: unknown; // T1-3: allow custom-schema fields to flow through DAG nodes
}

export interface NodeResult {
  nodeId: string;
  status: "completed" | "failed" | "skipped";
  result?: NodePayload;
  /** Stable typed failure taxonomy. Legacy checkpoints may omit this field. */
  errorInfo?: DAGNodeError;
  error?: string;
  /** Number of the attempt that produced this result. */
  attemptNumber?: number;
  /** Optional only for decoding checkpoints produced before lineage V1. */
  resultId?: string;
  lineage?: WorkflowNodeLineage;
}

export type DAGErrorCode =
  | "rate_limit"
  | "capacity"
  | "network"
  | "provider_abort"
  | "worker_crash"
  | "timeout"
  | "schema_invalid"
  | "verification_failed"
  | "policy_denied"
  | "approval_required"
  | "budget_exhausted"
  | "cancelled"
  | "internal";

export type DAGErrorRecovery = "retry_attempt" | "repair_schema" | "revise" | "wait_approval" | "wait_user" | "stop";

export interface DAGNodeError {
  code: DAGErrorCode;
  message: string;
  retryable: boolean;
  recovery: DAGErrorRecovery;
  details?: Record<string, unknown>;
}

export interface WorkflowLineage {
  workflowId: string;
  goalDefinitionId: string | null;
  revisionId: string | null;
  runId: string | null;
  attemptId: string | null;
  parentWorkflowId: string | null;
  previousWorkflowId: string | null;
}

export interface WorkflowNodeLineage extends WorkflowLineage {
  nodeId: string;
  parentNodeId: string | null;
  previousResultId: string | null;
  attemptNumber?: number;
}

export interface WaveResult {
  wave: number;
  successes: NodeResult[];
  failures: NodeResult[];
  skipped?: NodeResult[];
}

// (C5: ErrorContext interface removed — zero consumers; the executor propagates
// predecessor failures via the string errorContextPrefix() in state.ts. The
// structured type was speculative (5d design, deferred) with no callers.)

export interface DAGResult {
  status: "completed" | "partial" | "failed";
  /** Present on every new execution; absent only on legacy decoded values. */
  workflow?: WorkflowLineage;
  waves: WaveResult[];
  finalContext: Record<string, NodePayload>;
  /** Explicit state for every declared node. A result is never "completed"
   *  while any node remains queued or running. */
  nodeStates?: Record<string, DAGNodeState>;
  termination?: "all_terminal" | "aborted" | "blocked";
  metrics?: {
    totalNodes: number;
    completed: number;
    failed: number;
    skipped: number;
    queued: number;
    running: number;
    /** Configured runtime concurrency ceiling after validation/clamping. */
    maxConcurrent: number;
    /** Highest number of DAG nodes simultaneously running. */
    peakConcurrent: number;
    /** @deprecated Compatibility alias for wallTimeMs. */
    durationMs: number;
    /** Elapsed wall-clock time for this execute/resume invocation. */
    wallTimeMs: number;
    /** Sum of every node's measured run time. */
    serialTimeMs: number;
    /** Longest dependency path weighted by measured node run time. */
    criticalPathMs: number;
    /** Routing-node results evaluated during this invocation. */
    routeCount: number;
    /** Fan-out child sends dispatched during this invocation. */
    dispatchCount: number;
    /** Completed predecessor results injected into downstream node tasks. */
    downstreamResultConsumptionCount: number;
    nodeTimings: Record<string, {
      /** Time spent ready but waiting for concurrency or a write-scope lease. */
      queueTimeMs: number;
      /** Time from node launch until its terminal result. */
      runTimeMs: number;
    }>;
  };
  /** Non-blocking admission findings. These flag template-shaped or mergeable
   *  graphs without guessing intent from arbitrary task prose. */
  admissionDiagnostics?: DAGAdmissionDiagnostic[];
}

export interface DAGAdmissionDiagnostic {
  severity: "advisory";
  code: "mixed_semantic_contract" | "fork_join_template" | "merge_candidate";
  message: string;
  nodeId?: string;
}

/** Stable identity for a scheduler-visible child produced by a dispatch node. */
export interface GeneratedNodeRecord {
  id: string;
  key: string;
  parentId: string;
}

/** Persisted expansion marker. An empty generatedNodeIds array is meaningful:
 *  it records that a zero-child dispatch has already been evaluated. */
export interface DispatchExpansionRecord {
  parentId: string;
  generatedNodeIds: string[];
  source: "sends" | "dynamic" | "result";
  /** Validated fan-out inputs used to build the scheduler-visible children.
   *  Persisting these makes expanded topology mechanically reproducible after
   *  dynamic closures have been removed by JSON serialization. */
  sends: import("./send").Send[];
  /** A result-driven dispatcher has already run before expansion. Its payload
   *  is retained so resume can aggregate it without replaying the dispatcher. */
  dispatcherResult?: NodePayload;
}

/** Observability (Gap P3): emitted at wave start + per-node settle. */
export interface DAGProgress {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  scheduler?: DAGScheduler;
  /** Present on the final progress event. `all_terminal` only means every node
   *  settled; outcome still distinguishes completed, partial, and failed. */
  outcome?: DAGResult["status"];
  termination?: NonNullable<DAGResult["termination"]>;
  /** New executors always send a complete snapshot. Legacy partial updates omit
   *  this flag and retain the old wave-based inference in the UI adapter. */
  explicitStates?: boolean;
  nodes: Record<string, { status: DAGNodeStatus; error?: string; route?: string }>;
  /** Active topology after scheduler-visible dispatch expansion. */
  expandedSpec?: DAGSpec;
  /** Origin metadata for scheduler-generated children. Optional so legacy
   *  progress producers remain valid. */
  generatedNodes?: Record<string, GeneratedNodeRecord>;
}

export interface DAGExecutionSnapshot {
  workflow?: WorkflowLineage;
  scheduler: DAGScheduler;
  expandedSpec: DAGSpec;
  /** Preserved across resume so a JSON-stripped dynamic closure cannot be
   * mistaken for a result-driven dispatcher in the next checkpoint. */
  nodeModes?: Record<string, DAGNodeExecutionMode>;
  nodeStates: Record<string, DAGNodeState>;
  nodeResults: Record<string, NodeResult>;
  skipReasons: Record<string, string>;
  generatedNodes: Record<string, GeneratedNodeRecord>;
  dispatchExpansions: Record<string, DispatchExpansionRecord>;
  /** P1 runtime checkpoint material; adapters may leave these empty. */
  artifactDigests?: Record<string, { uri: string; digest: string; sizeBytes: number; verifiedAt: number }>;
  approvals?: Record<string, { decision: "pending" | "granted" | "denied" | "revoked"; capability: string; scope: string; revisionId: string; decidedAt?: number }>;
  sideEffectJournal?: Record<string, { idempotencyKey: string; operation: string; resource: string; requestDigest: string; status: "prepared" | "committed" | "failed"; attemptId: string; completedAt?: number }>;
}
