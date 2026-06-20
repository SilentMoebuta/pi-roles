// AgentHandle — lifecycle handle for spawned sub-agents.
//
// Phase 5 foundation: spawn_role({mode:'background'}) returns a handle immediately.
// The handle wraps the existing registry + runner promise, providing:
//   - wait():       Promise<AgentResult> (blocks until completion)
//   - status():     AgentStatus (current state)
//   - terminate():  force-stop the agent
//   - send():       stub (Phase 6 Teams — real inter-agent communication)
//   - pause/resume: stubs (Phase 6 Teams — lifecycle management)
//
// This is the ONLY new abstraction in Phase 5. DAG executor (Phase 5b),
// dynamic fan-out, and Teams (Phase 6) all build on AgentHandle.

import type { SpawnToolRecord } from "./spawn-role-tool";

export type AgentStatus = "queued" | "running" | "completed" | "aborted" | "error";

export interface AgentResult {
  status: "completed" | "aborted" | "error";
  result?: { findings: string[]; artifacts: string[] };
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
  readonly id: string;
  readonly role: string;
  private _record: () => SpawnToolRecord;
  private _waiter: Promise<SpawnToolRecord>;
  private _abort: () => void;
  private _lastRec?: SpawnToolRecord;
  readonly depth: number;

  constructor(
    id: string, role: string, depth: number,
    waiter: Promise<SpawnToolRecord>,
    record: () => SpawnToolRecord,
    abort: () => void,
  ) {
    this.id = id;
    this.role = role;
    this.depth = depth;
    this._waiter = waiter;
    // Store waiter result on settle so status() reflects actual state.
    waiter.then((rec) => { this._lastRec = rec; }).catch(() => {});
    this._record = record;
    this._abort = abort;
  }

  /** Current agent status (queued/running/completed/aborted/error). */
  status(): AgentStatus {
    const rec = this._lastRec ?? this._record();
    if (rec.status === "completed" || rec.status === "aborted" || rec.status === "error") {
      return rec.status as AgentStatus;
    }
    if (rec.turnCount && rec.turnCount > 0) return "running";
    return "queued";
  }

  /** Block until the agent completes, then return structured result. */
  async wait(): Promise<AgentResult> {
    const rec = await this._waiter;
    return {
      status: rec.status as "completed" | "aborted" | "error",
      result: rec.reportPayload ?? (rec.result ? { findings: [rec.result], artifacts: [] } : { findings: [], artifacts: [] }),
      error: rec.error ?? rec.reason,
      turnCount: rec.turnCount,
    };
  }

  /** Force-stop the agent. */
  terminate(): void {
    this._abort();
  }

  // ═══════════════════════════════════════════════
  // Phase 6 stubs (API defined, implementation deferred)
  // ═══════════════════════════════════════════════

  /** Phase 6: send instruction/data to running agent. */
  send(_message: AgentMessage): void {
    throw new Error("AgentHandle.send() not implemented (Phase 6).");
  }

  /** Phase 6: pause the agent. */
  pause(): void {
    throw new Error("AgentHandle.pause() not implemented (Phase 6).");
  }

  /** Phase 6: resume the agent. */
  resume(): void {
    throw new Error("AgentHandle.resume() not implemented (Phase 6).");
  }
}
