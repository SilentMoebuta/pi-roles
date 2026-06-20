// Phase 5b DAG executor: topological waves, each wave spawns all nodes in
// parallel and barriers on Promise.allSettled. BOTH the spawn phase AND the
// wait phase use allSettled, so a rejecting spawnFn OR a failing wait cannot
// abort sibling nodes (Phase 5b isolation guarantee — a node's failure is its
// own, not its wave's). Downstream nodes whose predecessor failed receive an
// error-context prefix on their task (5d). Uses an injected spawnFn so it
// never touches AgentHandle and stays structuredClone-safe.
import type { DAGSpec, WaveResult, NodeResult, DAGResult, DAGProgress } from "./types";
import { planWaves } from "./planner";
import { aggregateWaves, errorContextPrefix, upstreamResultsPrefix } from "./state";
import { fanOutSends } from "./send";
import type { DynamicNodeContext } from "./send";
import { sendToTask, type Send } from "./send";

export type SpawnOutcomeStatus = "completed" | "aborted" | "error" | "failed";

export interface SpawnHandle {
  // agentId is the spawn's id (reserved for future Teams/handle use); the
  // executor keys nodes by nodeId (from the DAG spec), NOT by agentId.
  agentId: string;
  wait: () => Promise<{
    status: SpawnOutcomeStatus;
    result?: { findings: string[]; artifacts: string[] };
    error?: string;
    reportPayload?: { findings: string[]; artifacts: string[] };
  }>;
}

export type SpawnFn = (role: string, task: string) => Promise<SpawnHandle>;

/** Internal options shared by executeDAG and resumeDAG (5e delegates to core). */
interface ExecuteOptions {
  /** Results already known (from a checkpoint) — seeds nodeResults so downstream
   *  nodes see upstream state. Used by resumeDAG. */
  initialNodeResults?: Map<string, NodeResult>;
  /** Skip waves before this index (already completed in a checkpoint). */
  startWaveIndex?: number;
  /** Wave results carried over from the checkpoint (prepended to the result). */
  priorWaveResults?: WaveResult[];
  /** Max concurrent spawns per wave (default 5). Caps parallel createAgentSession
   *  calls to prevent resource exhaustion (API rate limits, memory). */
  maxConcurrent?: number;
  /** Progress callback fired at wave start and per-node settle (Gap P3).
   *  Receives {dagId, currentWave, totalWaves, nodes: Record<nodeId,{status}>}. */
  onProgress?: (p: DAGProgress) => void;
  /** SOTA gap #2: caller abort signal. Checked between waves, before spawn,
   *  and raced against each h.wait(). When aborted, remaining waves are skipped
   *  and in-flight waits return early (LangGraph/OpenCode/Claude all have
   *  equivalents — we had _signal but discarded it). */
  signal?: AbortSignal;
  /** P2-6: DAG-level max depth. Checked at wave start; remaining waves skipped when depleted. */
  maxDepth?: number;
}

export async function executeDAGCore(spec: DAGSpec, spawnFn: SpawnFn, opts: ExecuteOptions = {}): Promise<DAGResult> {
  const waves = planWaves(spec);
  const waveResults: WaveResult[] = [...(opts.priorWaveResults ?? [])];
  const nodeResults = new Map<string, NodeResult>(opts.initialNodeResults ?? []);
  const startWaveIndex = opts.startWaveIndex ?? 0;
  const maxConcurrent = opts.maxConcurrent ?? 5;
  const dagMaxDepth = opts.maxDepth ?? (spec as any).maxDepth ?? 5;
  let currentDepth = dagMaxDepth;

  // Simple async semaphore — caps concurrent spawns within a wave.
  let running = 0;
  const pending: Array<() => void> = [];
  const acquire = async () => {
    if (running < maxConcurrent) { running++; return; }
    await new Promise<void>((r) => pending.push(r));
    running++;
  };
  const release = () => {
    running--;
    pending.shift()?.();
  };

  // Promise that rejects after ms (SOTA gap #1: per-node timeout).
  const timeoutReject = (ms: number) =>
    new Promise<never>((_, rej) => { setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); });
  // Promise that rejects when the signal fires (SOTA gap #2: mid-DAG abort).
  const abortWhenSignaled = (signal: AbortSignal) =>
    new Promise<never>((_, rej) => {
      if (signal.aborted) { rej(new Error("aborted")); return; }
      const onAbort = () => { rej(new Error("aborted")); signal.removeEventListener("abort", onAbort); };
      signal.addEventListener("abort", onAbort);
    });

  for (let wi = startWaveIndex; wi < waves.length; wi++) {
    const wave = waves[wi];
    // SOTA gap #2: between-wave abort — skip remaining waves if caller cancelled.
    if (opts.signal?.aborted) break;
    // P2-6: DAG depth guard — skip remaining waves when depth exhausted.
    if (currentDepth <= 0) break;
    currentDepth--;
    // Emit progress: wave start — all nodes queued.
    opts.onProgress?.({
      dagId: "", currentWave: wi, totalWaves: waves.length,
      nodes: Object.fromEntries(wave.nodes.map((n) => [n.id, { status: "queued" as const }])),
    });
    // PARALLEL spawn (allSettled — a rejecting spawnFn does NOT abort siblings).
    // A node may be static (1 handle) or dynamic (Phase 5c: returns Send[] → N handles).
    const spawned = await Promise.allSettled(
      wave.nodes.map(async (n) => {
        await acquire();
        // SOTA gap #2: abort check after semaphore acquire (yield point).
        if (opts.signal?.aborted) { release(); throw new Error("aborted"); }
        try {
          let task = n.task;
          const failedDeps = n.deps.filter((d) => nodeResults.get(d)?.status === "failed");
          for (const d of failedDeps) {
            task += errorContextPrefix(d, nodeResults.get(d)!.error ?? "unknown");
          }
          // Gap D: inject upstream completed results as a JSON block so the
          // downstream node (reviewer) knows the ACTUAL artifacts produced.
          const completedDeps: Record<string, { findings: string[]; artifacts: string[] }> = {};
          for (const d of n.deps ?? []) {
            const nr = nodeResults.get(d);
            if (nr?.status === "completed" && nr.result) completedDeps[d] = nr.result;
          }
          if (Object.keys(completedDeps).length > 0) {
            task += upstreamResultsPrefix(completedDeps);
          }
          let handles: SpawnHandle[];
          if (n.sends && n.sends.length > 0) {
            // SOTA gap #3: serializable Send[] — fan out directly (closure-free, JSON-safe).
            handles = [];
            for (const s of n.sends) {
              const h = await spawnFn(s.role, sendToTask(s));
              handles.push(h);
            }
          } else if (n.dynamic) {
          // Phase 5c: dynamic node — invoke to get Send[], fan out in parallel.
          const deps: DynamicNodeContext["dependencies"] = {};
          for (const d of n.deps ?? []) {
            const nr = nodeResults.get(d);
            if (nr) {
              deps[d] = { status: nr.status as "completed" | "failed", result: nr.result, error: nr.error };
            }
          }
          const sends = await n.dynamic({ nodeId: n.id, dependencies: deps });
          const fanned = await fanOutSends(sends, spawnFn);
          // fanOutSends uses allSettled: a rejecting Send → undefined. Replace
          // undefined with a synthetic failed handle so the wait phase marks
          // the dynamic node failed (per-Send isolation, mirrors spawn allSettled).
          handles = fanned.map((h, i) => h ?? {
            agentId: `failed-send-${i}`,
            wait: async () => ({ status: "failed" as const, error: "send spawn rejected" }),
          });
        } else {
          handles = [await spawnFn(n.role, task)];
        }
        return { nodeId: n.id, handles };
        } finally {
          release();
        }
      }),
    );

    // Partition: rejected spawns → immediate failed NodeResult; fulfilled → wait.
    const successes: NodeResult[] = [];
    const failures: NodeResult[] = [];
    const toWait: { nodeId: string; handles: SpawnHandle[]; timeoutMs?: number }[] = [];
    spawned.forEach((res, i) => {
      const nodeId = wave.nodes[i].id;
      if (res.status === "rejected") {
        const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const nr: NodeResult = { nodeId, status: "failed", error: err };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      } else {
        toWait.push({ nodeId, handles: res.value.handles, timeoutMs: wave.nodes[i].timeout_ms });
      }
    });

    // BARRIER: wait for all spawned nodes — each wait raced against per-node
    // timeout (SOTA gap #1) and global abort signal (SOTA gap #2).
    const settled = await Promise.allSettled(toWait.flatMap(({ handles, timeoutMs }) =>
      handles.map((h) => {
        let waitP = h.wait();
        if (timeoutMs !== undefined) {
          waitP = Promise.race([waitP, timeoutReject(timeoutMs)]);
        }
        if (opts.signal) {
          waitP = Promise.race([waitP, abortWhenSignaled(opts.signal)]);
        }
        return waitP;
      })
    ));
    // Map each settled result back to its nodeId (handles were flattened in toWait order).
    let flatIdx = 0;
    for (const { nodeId, handles } of toWait) {
      const subResults: { findings: string[]; artifacts: string[] }[] = [];
      let subError: string | undefined;
      let allCompleted = true;
      for (let j = 0; j < handles.length; j++) {
        const res = settled[flatIdx++];
        if (res.status === "fulfilled" && res.value.status === "completed") {
          subResults.push(res.value.reportPayload ?? res.value.result ?? { findings: [], artifacts: [] });
        } else {
          allCompleted = false;
          subError = res.status === "fulfilled" ? (res.value.error ?? res.value.status) : (res.reason instanceof Error ? res.reason.message : String(res.reason));
        }
      }
      if (allCompleted) {
        const merged: NodeResult = {
          nodeId,
          status: "completed",
          result: {
            findings: subResults.flatMap((r) => r.findings),
            artifacts: subResults.flatMap((r) => r.artifacts),
          },
        };
        successes.push(merged);
        nodeResults.set(nodeId, merged);
      } else {
        const nr: NodeResult = { nodeId, status: "failed", error: subError ?? "unknown" };
        failures.push(nr);
        nodeResults.set(nodeId, nr);
      }
    }

    waveResults.push({ wave: wave.index, successes, failures });
    // Emit progress: wave settled — per-node final status.
    const settledStatus: Record<string, { status: "completed" | "failed"; error?: string }> = {};
    for (const s of successes) settledStatus[s.nodeId] = { status: "completed" };
    for (const f of failures) settledStatus[f.nodeId] = { status: "failed", error: f.error };
    opts.onProgress?.({ dagId: "", currentWave: wi, totalWaves: waves.length, nodes: settledStatus });
  }

  return aggregateWaves(waveResults);
}

/** Execute a full DAG from scratch. */
export async function executeDAG(spec: DAGSpec, spawnFn: SpawnFn): Promise<DAGResult> {
  return executeDAGCore(spec, spawnFn);
}
