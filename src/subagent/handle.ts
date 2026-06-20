// AgentHandle — pure-data lifecycle handle for spawned sub-agents.
//
// Phase 5a clone-bug fix: the previous version stored a record arrow-fn, a
// Promise (waiter), and an abort closure as INSTANCE fields. pi core's
// emitContext runs structuredClone(messages) before every provider call; any
// handle entering the message graph threw DataCloneError on the record arrow-fn
// ("() => ({ id, status: \"queued\", turnCount: 0 }) could not be cloned."),
// deadlocking the pi-goal continuation loop. This class holds ONLY primitive
// data (id/role/depth) so it is structuredClone-safe; lifecycle ops resolve
// live via the injected service (no captured closures).
//
// spawn_role background mode no longer constructs a handle (returns agentId
// only); handles are created on demand by callers that need the lifecycle API
// (future DAG/Teams). The DAG executor does NOT use AgentHandle — it drives
// the service directly via an injected spawnFn (see src/dag/executor.ts).

import type { SpawnToolService, SpawnToolRecord } from "./spawn-role-tool";
import type { NodePayload } from "../dag/types";

export type AgentStatus = "queued" | "running" | "completed" | "aborted" | "error";

export interface AgentResult {
  status: "completed" | "aborted" | "error";
  result?: NodePayload;
  error?: string;
  turnCount?: number;
}

export interface AgentMessage {
  type: string;
  content: string;
  from?: string;
  timestamp?: number;
}

export class AgentHandle {
  constructor(
    readonly id: string,
    readonly role: string,
    readonly depth: number,
  ) {}

  /** Current agent status, resolved live from the service (no cached closure). */
  status(svc: SpawnToolService): AgentStatus {
    const rec: SpawnToolRecord | undefined = svc.getRecord(this.id);
    if (!rec) return "queued";
    if (rec.status === "completed" || rec.status === "aborted" || rec.status === "error") {
      return rec.status as AgentStatus;
    }
    if (rec.turnCount && rec.turnCount > 0) return "running";
    return "queued";
  }

  /** Block until the agent completes, then return structured result. */
  async wait(svc: SpawnToolService): Promise<AgentResult> {
    const rec: SpawnToolRecord = await svc.waitForResult(this.id);
    // T1-3: reportPayload may be a custom-schema shape; adapt to NodePayload.
    const rp = rec.reportPayload;
    const result: NodePayload = rp && Array.isArray((rp as any).findings) && Array.isArray((rp as any).artifacts)
      ? { findings: (rp as any).findings, artifacts: (rp as any).artifacts, ...rp }
      : (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] });
    return {
      status: rec.status as AgentResult["status"],
      result,
      error: rec.error ?? rec.reason,
      turnCount: rec.turnCount,
    };
  }

  /** Force-stop the agent. */
  terminate(svc: SpawnToolService): boolean {
    return svc.abort(this.id);
  }

  // ═══════════════════════════════════════════════
  // Phase 6 stubs (API defined, implementation deferred)
  // ═══════════════════════════════════════════════
  send(_message: AgentMessage): void { throw new Error("AgentHandle.send() not implemented (Phase 6)."); }
  pause(): void { throw new Error("AgentHandle.pause() not implemented (Phase 6)."); }
  resume(): void { throw new Error("AgentHandle.resume() not implemented (Phase 6)."); }
}
