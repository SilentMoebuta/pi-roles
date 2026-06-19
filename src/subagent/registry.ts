// SubagentRegistry — in-process map of subagent id → live state + completion promise.
//
// Fixes gotgenes' gap: gotgenes' public getRecord returned a stateless snapshot
// with no promise, so callers could only poll status to wait for completion.
// Here waitForResult(id) returns a promise that settles when the run terminates.
//
// Known limitation (same class as gotgenes/OpenClaw announce): in-process only,
// lost on crash. Cross-process durability → SQLite (deferred, see design doc §十一·五).

import { SubagentState, type SubagentStatus } from "./state";

export interface SubagentRecord {
  id: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  reason?: string;  // abort cause: "step-limit" | "liveness" | "caller-abort" (runtime-derived, not model text)
  sessionFile?: string;  // child session file — spawn_role keys the旁路 payload lookup by it
  startedAt?: number;
  completedAt?: number;
  turnCount: number;
}

interface Entry {
  id: string;
  state: SubagentState;
  resolve: (rec: SubagentRecord) => void;
  reject: (err: Error) => void;
  promise: Promise<SubagentRecord>;
  settled: boolean;
  reason?: string;
  turnCount?: number;
  sessionFile?: string;
}

export class SubagentRegistry {
  private entries = new Map<string, Entry>();
  private counter = 0;

  /** Create a new run entry. Returns its id. */
  register(): string {
    const id = `sub_${Date.now()}_${this.counter++}`;
    let resolveFn!: (rec: SubagentRecord) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<SubagentRecord>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    this.entries.set(id, {
      id,
      state: new SubagentState(),
      resolve: resolveFn,
      reject: rejectFn,
      promise,
      settled: false,
    });
    return id;
  }

  /** Live state for mutation by the runner. Throws if unknown. */
  stateOf(id: string): SubagentState | undefined {
    return this.entries.get(id)?.state;
  }

  /** Stateless snapshot of the current record, or undefined if unknown. */
  getRecord(id: string): SubagentRecord | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    return this.snapshot(e);
  }

  /** Promise that settles when the run terminates. Throws if unknown. */
  waitForResult(id: string): Promise<SubagentRecord> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown subagent id: ${id}`);
    return e.promise;
  }

  /** Settle the run with a terminal state transition. Throws if already settled or unknown. */
  resolve(id: string, transition: (s: SubagentState) => void, reason?: string, turnCount?: number, sessionFile?: string): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown subagent id: ${id}`);
    if (e.settled) throw new Error(`subagent ${id} already settled`);
    transition(e.state);
    e.settled = true;
    e.reason = reason;
    e.turnCount = turnCount;
    e.sessionFile = sessionFile;
    e.resolve(this.snapshot(e));
  }

  /** Settle the run with an error (runner threw). Throws if already settled or unknown. */
  reject(id: string, err: Error): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown subagent id: ${id}`);
    if (e.settled) throw new Error(`subagent ${id} already settled`);
    e.settled = true;
    e.reject(err);
  }

  listAgents(): string[] {
    return [...this.entries.keys()];
  }

  hasRunning(): boolean {
    for (const e of this.entries.values()) {
      if (!e.settled) return true;
    }
    return false;
  }

  private snapshot(e: Entry): SubagentRecord {
    const s = e.state;
    return {
      id: e.id,
      status: s.status,
      result: s.result,
      error: s.error,
      reason: e.reason,
      sessionFile: e.sessionFile,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      turnCount: e.turnCount ?? 0,
    };
  }
}
