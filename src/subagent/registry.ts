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
  sessionFile?: string;  // child session file
  reportPayload?: Record<string, unknown>;  // extracted from child session's report_role_result tool call
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
  reportPayload?: Record<string, unknown>;
}

export class SubagentRegistry {
  private entries = new Map<string, Entry>();
  private counter = 0;
  /** T3-2: optional cap on terminal records; evicted inline on settle. */
  maxTerminalRecords?: number;
  /** T3-2: optional sink for evicted ids (so the service can prune its own
   *  handles/children/agentToSessionFile/reportState maps in lockstep). */
  onEvict?: (ids: string[]) => void;

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
  resolve(id: string, transition: (s: SubagentState) => void, reason?: string, turnCount?: number, sessionFile?: string, reportPayload?: Record<string, unknown>): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown subagent id: ${id}`);
    if (e.settled) throw new Error(`subagent ${id} already settled`);
    transition(e.state);
    e.settled = true;
    e.reason = reason;
    e.turnCount = turnCount;
    e.sessionFile = sessionFile;
    e.reportPayload = reportPayload;
    e.resolve(this.snapshot(e));
    this.maybeEvict();
  }

  /** Settle the run with an error (runner threw, OR spawn failed before the
   *  runner started — T3-3). Transitions state to 'error' (was left 'queued' on
   *  spawn-failure, so getRecord reported a dead run as still queued). */
  reject(id: string, err: Error): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown subagent id: ${id}`);
    if (e.settled) throw new Error(`subagent ${id} already settled`);
    e.settled = true;
    // T3-3: force-error the state if it's still non-terminal (spawn failed before
    // markRunning). markError requires 'running', so set directly for the queued case.
    if (!e.state.isTerminal()) {
      e.state.markErrorFromReject(err.message);
    }
    e.reject(err);
    this.maybeEvict();
  }

  private maybeEvict(): void {
    if (!this.maxTerminalRecords) return;
    const before = [...this.entries.keys()];
    const n = this.evictTerminal(this.maxTerminalRecords);
    if (n > 0 && this.onEvict) {
      const after = new Set(this.entries.keys());
      this.onEvict(before.filter((id) => !after.has(id)));
    }
  }

  listAgents(): string[] {
    return [...this.entries.keys()];
  }

  /** T3-2: evict the oldest TERMINAL records until at most `cap` remain.
   *  Never touches in-flight (unsettled) records. Map insertion-order gives
   *  'oldest' with no access-time bookkeeping (terminal records aren't re-accessed).
   *  Returns the count evicted. */
  evictTerminal(cap: number): number {
    if (cap <= 0) return 0;
    let evicted = 0;
    while (this.countTerminal() > cap) {
      // Find the first terminal entry by insertion order and remove it.
      let removed = false;
      for (const [id, e] of this.entries) {
        if (e.settled && e.state.isTerminal()) {
          this.entries.delete(id);
          evicted++;
          removed = true;
          break;
        }
      }
      if (!removed) break; // no terminal to evict (rest are in-flight)
    }
    return evicted;
  }

  private countTerminal(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.settled && e.state.isTerminal()) n++;
    return n;
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
      reportPayload: e.reportPayload,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      turnCount: e.turnCount ?? 0,
    };
  }
}
