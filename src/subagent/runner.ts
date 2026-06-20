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
  // T3-1: expose the message log so extractReportPayload can scan it for the
  // report_role_result toolCall WITHOUT an `as any` cast (pi's AgentSession
  // provides this via get messages()). Minimal inline shape — keeps the surface
  // narrow; extractReportPayload accepts any[] content.
  messages?: Array<{ role: string; content: any[] }>;
  // bindExtensions fires the session_start event (the only emit point — see pi
  // core agent-session.js bindExtensions). Without it, the pi-roles
  // session_start handler that additively adds report_role_result to a role
  // session's active tools NEVER runs, so children can't call the output-
  // contract tool. Called once after createSession, before prompt.
  // Optional on the interface so minimal test fakes don't have to stub it;
  // the real pi AgentSession always provides it.
  bindExtensions?(bindings?: { mode?: string; [k: string]: unknown }): Promise<void>;
}

export type SubagentEvent =
  | { type: "message_end"; message: { role: string; content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> } }
  // G-LIV-1: pi's session.subscribe DOES emit tool_execution_* to subscribers
  // (agent-session.js _handleAgentEvent emits the raw event for all types), so
  // handling them here is sound in prod (confirmed by probe-g-liv-1-liveness-live).
  | { type: "tool_execution_start"; toolCallId?: string; toolName?: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }
  // message_update = assistant streaming token batches (a long generation is alive).
  | { type: "message_update"; message: { role: string; content: Array<{ type: string; text?: string }> } }
  | { type: "turn_end" }
  | { type: "agent_end" };

export interface RunOptions {
  maxTurns?: number;       // undefined or 0 = unlimited
  signal?: AbortSignal;    // caller abort
  /** Liveness safety net (generous, per Hermes lesson). DEFAULTS ON at 300_000ms
   *  (5 min) — a hung provider (no turn_end) must not hold a concurrency slot
   *  forever (5 hung bg = deadlock). Pass 0 to explicitly disable. T1-2. */
  livenessMs?: number;
  pollMs?: number;         // liveness check interval (default livenessMs/2 or 500)
  /** P1-4 doom-loop detection. DEFAULTS ON. Aborts after 3 consecutive identical
   *  tool-name+input-hash calls (SOTA: OpenCode tracks tool+input, not text). T1-2. */
  doomLoop?: boolean;
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
  // T1-2: liveness defaults ON (300_000ms) unless explicitly set to 0.
  // `=== undefined` (not `> 0`) so an explicit 0 still disables (opt-out).
  const livenessMs = opts.livenessMs === undefined ? 300_000 : opts.livenessMs;
  const pollMs = opts.pollMs ?? (livenessMs > 0 ? Math.max(10, Math.floor(livenessMs / 2)) : 0);
  // T1-2: doomLoop defaults ON.
  const doomLoop = opts.doomLoop ?? true;

  let turnCount = 0;
  let lastAssistantText: string | undefined;
  // P1-4 doom-loop: track last 3 tool-name+input-hash signatures (SOTA: OpenCode
  // tracks tool+input, not assistant text — a role stuck calling the same
  // failing tool with varied/no text is NOT caught by a text signal). Also keep
  // the assistant-text signal as a secondary (harmless; catches pure text loops).
  const recentToolSigs: string[] = [];
  const recentTexts: string[] = [];
  let abortReason: "step-limit" | "liveness" | "caller-abort" | "doom-loop" | null = null;
  let lastActivity = Date.now();
  // G-LIV-1: pause liveness while a tool executes (the agent is waiting on an
  // external op, not hung). A long tool that exceeds livenessMs must NOT
  // false-abort a healthy child. A hung PROVIDER (no events at all) keeps
  // toolInProgress=false → liveness still fires (true-positive preserved).
  let toolInProgress = false;

  const unsub = session.subscribe((e) => {
    // G-LIV-1: refresh liveness on activity mid-turn. tool_execution PAUSES the
    // check (agent waits on a tool, not hung); message_end (any role) resets it.
    // Without this, a multi-second tool or a long generation trips livenessMs
    // and false-aborts a healthy child (SOTA: LangGraph Runtime.heartbeat).
    if (e.type === "tool_execution_start") {
      toolInProgress = true;
    } else if (e.type === "tool_execution_end") {
      toolInProgress = false;
      lastActivity = Date.now();
    } else if (e.type === "message_end" || e.type === "message_update") {
      lastActivity = Date.now();
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      const text = e.message.content
        .filter((c) => c.type === "text" && typeof (c as any).text === "string")
        .map((c) => (c as any).text as string)
        .join("");
      if (text.length > 0) lastAssistantText = text;
      // T1-2: doom-loop on tool-name+input-hash (primary SOTA signal).
      if (doomLoop) {
        const toolCalls = e.message.content.filter((c) => c.type === "toolCall");
        for (const tc of toolCalls) {
          const name = (tc as any).name ?? "";
          const args = (tc as any).arguments;
          const sig = name + "|" + JSON.stringify(args ?? {});
          recentToolSigs.push(sig);
          if (recentToolSigs.length > 3) recentToolSigs.shift();
        }
        if (recentToolSigs.length === 3 && recentToolSigs[0] === recentToolSigs[1] && recentToolSigs[1] === recentToolSigs[2] && abortReason === null) {
          abortReason = "doom-loop";
          try { session.abort(); } catch {}
        }
        // Secondary: assistant-text repetition (catches pure text loops; harmless).
        if (text.length > 0) {
          recentTexts.push(text);
          if (recentTexts.length > 3) recentTexts.shift();
          if (recentTexts.length === 3 && recentTexts[0] === recentTexts[1] && recentTexts[1] === recentTexts[2] && abortReason === null) {
            abortReason = "doom-loop";
            try { session.abort(); } catch {}
          }
        }
      }
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
      // G-LIV-1: skip while a tool is executing (agent is waiting, not hung).
      if (!toolInProgress && Date.now() - lastActivity >= livenessMs && abortReason === null) {
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
