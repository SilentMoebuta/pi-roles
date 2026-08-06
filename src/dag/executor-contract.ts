import type {
  DAGExecutionSnapshot,
  DAGNodeExecutionMode,
  DAGNodeState,
  DAGProgress,
  DAGScheduler,
  DispatchExpansionRecord,
  GeneratedNodeRecord,
  NodePayload,
  NodeResult,
  WaveResult,
} from "./types";
import type { InlineRoleDef } from "../subagent/spawn-role-tool";

export type SpawnOutcomeStatus = "completed" | "aborted" | "error" | "failed";

export interface SpawnHandle {
  agentId: string;
  wait: () => Promise<{
    status: SpawnOutcomeStatus;
    result?: NodePayload;
    error?: string;
    reportPayload?: Record<string, unknown>;
  }>;
  /** Optional best-effort cancellation, used when a node times out. */
  abort?: () => void;
}

export type SpawnFn = (
  role: string | undefined,
  task: string,
  roleDef?: InlineRoleDef,
  model?: string,
  thinkingLevel?: string,
  routes?: Record<string, string[]>,
  /** Present only when this spawned node must return a result-driven Send[]. */
  dispatchMaxChildren?: number,
) => Promise<SpawnHandle>;

export interface ExecuteOptions {
  initialNodeResults?: Map<string, NodeResult>;
  initialNodeStates?: Record<string, DAGNodeState>;
  /** Legacy V1 resume fields. Results are projected into explicit node state. */
  startWaveIndex?: number;
  priorWaveResults?: WaveResult[];
  initialSkipReasons?: Map<string, string>;
  initialGeneratedNodes?: Record<string, GeneratedNodeRecord>;
  initialDispatchExpansions?: Record<string, DispatchExpansionRecord>;
  /** Original execution modes from a V2 checkpoint. Required on resume
   * because JSON serialization removes legacy dynamic closures. */
  initialNodeModes?: Record<string, DAGNodeExecutionMode>;
  maxConcurrent?: number;
  scheduler?: DAGScheduler;
  /** Optional role catalog used to preflight both declared and runtime-generated
   *  children before any member of a fan-out batch is spawned. */
  knownRoles?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  onProgress?: (p: DAGProgress) => void;
  onCheckpoint?: (snapshot: DAGExecutionSnapshot) => void;
  signal?: AbortSignal;
  /** Injectable monotonic wall clock for deterministic metrics tests. */
  now?: () => number;
  /** @deprecated Wave count is not nesting depth; retained as a no-op. */
  maxDepth?: number;
}

export interface SpawnOutcome {
  status: SpawnOutcomeStatus;
  result?: NodePayload;
  error?: string;
  reportPayload?: Record<string, unknown>;
}

export interface ExecutionCounters {
  routeCount: number;
  dispatchCount: number;
  downstreamResultConsumptionCount: number;
}
