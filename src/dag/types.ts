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
  /** B-class dynamic routing: node result payload must contain `route`, which
   *  selects one key from this whitelist. Selected target nodes run; unselected
   *  targets are marked skipped. Targets must be downstream dependents. */
  routes?: Record<string, string[]>;
}

export interface DAGSpec {
  nodes: Record<string, DAGNode>;
  /** P2-6: max DAG nesting depth (default inherited, typically 5). */
  maxDepth?: number;
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
  error?: string;
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
  waves: WaveResult[];
  finalContext: Record<string, NodePayload>;
}

/** Observability (Gap P3): emitted at wave start + per-node settle. */
export interface DAGProgress {
  dagId: string;
  currentWave: number;
  totalWaves: number;
  nodes: Record<string, { status: "queued" | "running" | "completed" | "failed" | "skipped"; error?: string; route?: string }>;
}
