// SubagentState — pure lifecycle state machine for a subagent run.
//
// PRINCIPLE (informed by OpenClaw research, research/2026-06-19-advanced-agent-subagent-impl-study.md §3.2):
// Status derives ONLY from runtime transitions (markRunning/markCompleted/markAborted/markError),
// NEVER from parsing model/assistant text. Do not add logic that infers "completed" from assistant output.
//
// Owns: status, result, error, timestamps. (turnCount is owned by the runner
// outcome, stamped onto the record at resolve — see registry.)

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "aborted"
  | "error";

const TERMINAL: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "aborted",
  "error",
]);

export class SubagentState {
  private _status: SubagentStatus = "queued";
  private _result?: string;
  private _error?: string;
  private _startedAt?: number;
  private _completedAt?: number;

  get status(): SubagentStatus {
    return this._status;
  }
  get result(): string | undefined {
    return this._result;
  }
  get error(): string | undefined {
    return this._error;
  }
  get startedAt(): number | undefined {
    return this._startedAt;
  }
  get completedAt(): number | undefined {
    return this._completedAt;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  markRunning(startedAt: number): void {
    if (this._status !== "queued") {
      throw new Error(`cannot markRunning from status ${this._status}`);
    }
    this._status = "running";
    this._startedAt = startedAt;
  }

  markCompleted(result: string, completedAt: number): void {
    this.transitionTo("completed", completedAt);
    this._result = result;
  }

  markAborted(completedAt: number): void {
    // Allow abort from queued (never started) OR running. queued→aborted covers
    // a subagent cancelled before dispatch (runner fix per reviewer finding).
    if (this._status !== "running" && this._status !== "queued") {
      throw new Error(`cannot markAborted from status ${this._status}`);
    }
    this._status = "aborted";
    this._completedAt = completedAt;
  }

  markError(error: string, completedAt: number): void {
    this.transitionTo("error", completedAt);
    this._error = error;
  }

  // turnCount is NOT owned here — the runner counts turns privately and stamps
  // the record at resolve (see registry). Earlier doc referenced a state-level
  // counter; removed to avoid duplication (reviewer finding).

  private transitionTo(target: SubagentStatus, completedAt: number): void {
    if (this._status !== "running") {
      throw new Error(`cannot transition to ${target} from status ${this._status}`);
    }
    this._status = target;
    this._completedAt = completedAt;
  }
}
