// Phase 5c: Dynamic Send fan-out. A node can be a DynamicNode — instead of a
// fixed {role, task}, it returns Send[] at runtime, and the executor fans those
// out as N parallel spawns within the same super-step (wave). This enables
// LLM-determined parallelism (e.g. a planner that decides 3 coders are needed).
// Mirrors docs/superpowers/specs/2026-06-20-pi-roles-phase5-complete-design.md §5c.

// SpawnHandle imported lazily via `import("./executor").SpawnHandle` in the
// signature to avoid a hard type re-export; send.ts is a leaf fan-out helper.

/** A single dynamic invocation: target role + custom input (the task text). */
export interface Send {
  role: string;
  arg: Record<string, unknown> | string; // string = task text; object = serialized
}

/** A node that dynamically decides its fan-out at runtime. Returns Send[]. */
export type DynamicNode = (ctx: DynamicNodeContext) => Promise<Send[]>;

/** Context handed to a DynamicNode: upstream results + a nodeId for logging. */
export interface DynamicNodeContext {
  nodeId: string;
  /** Results of this node's declared dependencies (completed ones). */
  dependencies: Record<string, { findings: string[]; artifacts: string[] }>;
}

/** Resolve a Send.arg into the task string passed to spawnFn. */
export function sendToTask(s: Send): string {
  return typeof s.arg === "string" ? s.arg : JSON.stringify(s.arg);
}

/**
 * Fan out a DynamicNode's Sends in parallel within one super-step, returning
 * SpawnHandles for each (the caller barriers on these via Promise.allSettled).
 * Uses Promise.allSettled so a rejecting spawnFn in ONE Send does NOT abort the
 * others — per-Send spawn-phase isolation, mirroring the executor's own spawn
 * phase. Rejected Sends are returned as undefined; the caller (executor) treats
 * a dynamic node with any failed Send as a failed NodeResult.
 */
export async function fanOutSends(
  sends: Send[],
  spawnFn: (role: string, task: string) => Promise<import("./executor").SpawnHandle>,
): Promise<(import("./executor").SpawnHandle | undefined)[]> {
  const settled = await Promise.allSettled(sends.map(async (s) => spawnFn(s.role, sendToTask(s))));
  return settled.map((r) => (r.status === "fulfilled" ? r.value : undefined));
}
