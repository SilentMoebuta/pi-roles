// runSubagent — drives a subagent session to completion with safety controls.
//
// pi primitive basis (research note Appendix A): session.prompt(task) blocks until
// agent_end (the whole task), returning void; turn_end fires once per turn;
// session.abort() is graceful (prompt resolves, does not reject). So we call
// prompt() ONCE and observe turn_end to enforce limits.
//
// Controls (informed by OpenClaw/Hermes research):
// - maxTurns: PRIMARY bound (Hermes iteration budget). undefined/0 = unlimited.
// - livenessMs: generous SAFETY NET only (Hermes killed busy children with aggressive
//   timeouts). Default 0 = disabled. When set, aborts only if no turn_end within window.
// - signal: caller abort (parent ESC) → session.abort().
// Status derives from runtime, never from model text (OpenClaw principle).

// Minimal event shape the runner consumes (subset of pi's AgentSessionEvent).
export interface SubagentSession {
  prompt(text: string, options?: unknown): Promise<void>;
  subscribe(listener: (event: SubagentEvent) => void): () => void;
  abort(): void;
  setActiveToolsByName(names: string[]): void;
}

export type SubagentEvent =
  | { type: "message_end"; message: { role: string; content: Array<{ type: string; text?: string }> } }
  | { type: "turn_end" }
  | { type: "agent_end" };

export interface RunOptions {
  maxTurns?: number;       // undefined or 0 = unlimited
  signal?: AbortSignal;    // caller abort
  livenessMs?: number;    // 0 / undefined = no liveness timeout (generous default)
  pollMs?: number;         // liveness check interval (default livenessMs/2 or 500)
}

export type RunStatus = "completed" | "aborted" | "error";

export interface RunOutcome {
  status: RunStatus;
  reason?: string;   // "step-limit" | "liveness" | "caller-abort" | error message
  finalText?: string; // last assistant text (fallback result)
  turnCount: number;
}

export async function runSubagent(
  session: SubagentSession,
  task: string,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  const maxTurns = opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : undefined;
  const livenessMs = opts.livenessMs && opts.livenessMs > 0 ? opts.livenessMs : 0;
  const pollMs = opts.pollMs ?? (livenessMs > 0 ? Math.max(10, Math.floor(livenessMs / 2)) : 0);

  let turnCount = 0;
  let lastAssistantText: string | undefined;
  let abortReason: "step-limit" | "liveness" | "caller-abort" | null = null;
  let lastActivity = Date.now();

  const unsub = session.subscribe((e) => {
    if (e.type === "message_end" && e.message.role === "assistant") {
      const text = e.message.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("");
      if (text.length > 0) lastAssistantText = text;
    }
    if (e.type === "turn_end") {
      turnCount++;
      lastActivity = Date.now();
      if (maxTurns && turnCount >= maxTurns && abortReason === null) {
        abortReason = "step-limit";
        try { session.abort(); } catch { /* swallow: abort best-effort */ }
      }
    }
  });

  // Caller-signal abort (parent ESC).
  let onCallerAbort: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortReason = "caller-abort";
    } else {
      onCallerAbort = () => {
        if (abortReason === null) abortReason = "caller-abort";
        try { session.abort(); } catch { /* swallow */ }
      };
      opts.signal.addEventListener("abort", onCallerAbort);
    }
  }

  // Liveness safety net (generous; only when explicitly enabled).
  let livenessTimer: NodeJS.Timeout | null = null;
  if (livenessMs > 0) {
    livenessTimer = setInterval(() => {
      if (Date.now() - lastActivity >= livenessMs && abortReason === null) {
        abortReason = "liveness";
        try { session.abort(); } catch { /* swallow */ }
      }
    }, pollMs);
  }

  let outcome: RunOutcome;
  try {
    if (abortReason === "caller-abort") {
      // already aborted before prompt started
      try { session.abort(); } catch { /* swallow */ }
    }
    await session.prompt(task);
    if (abortReason === null) {
      outcome = { status: "completed", finalText: lastAssistantText, turnCount };
    } else {
      outcome = { status: "aborted", reason: abortReason, finalText: lastAssistantText, turnCount };
    }
  } catch (err) {
    outcome = {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      finalText: lastAssistantText,
      turnCount,
    };
  } finally {
    unsub();
    if (livenessTimer) clearInterval(livenessTimer);
    if (onCallerAbort && opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }
  return outcome;
}
