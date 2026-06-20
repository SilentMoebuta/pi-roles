// makeOutputContractEnforcer — P0-4: proactive output-contract enforcement.
//
// The report_role_result tool is force-included + added via session_start, but
// the model can still finish without calling it. The reactive extractReportPayload
// (message scan) recovers the result post-hoc, but models frequently omit the
// final contract tool after long runs (the exact researcher maxTurns:9999 case).
//
// Fix (per approved plan + researcher verdict, HYBRID — convergent across
// Codex/Claude/OpenCode): KEEP reactive extractReportPayload (correct extraction
// path, no cross-session state). ADD a CHILD-side agent_end handler (gated on
// the parentSession header — the decisive fact that child-side pi.on fires for
// the child) that scans event.messages for a report_role_result toolCall; if
// absent and retries < 2, sends a reminder via pi.sendUserMessage(deliverAs:'steer',
// triggerTurn:true) so the child gets another turn to call the tool. Bounded by
// a retry counter to prevent infinite loops.
//
// extractReportPayload remains the last line of defense (still scans on settle).

export interface OutputContractDeps {
  /** Send the reminder to the child session (mirrors pi.sendUserMessage with
   *  deliverAs:'steer' + triggerTurn:true — queues after the current turn and
   *  triggers a new turn so the child actually runs again). */
  sendReminder: (text: string) => void;
  /** Max reminder retries before giving up (default 2). */
  maxRetries?: number;
}

export interface AgentEndEventLike {
  type: "agent_end";
  messages?: Array<{ role?: string; content?: Array<{ type?: string; name?: string }> }>;
}

export interface OutputContractCtxLike {
  sessionManager?: { getSessionFile?: () => string | undefined; getHeader?: () => { parentSession?: string } | undefined };
}

const REPORT_TOOL = "report_role_result";
const REMINDER_TEXT = "You have not called report_role_result. You MUST call report_role_result now with your findings and artifacts before finishing. This is a required output-contract step.";

export function makeOutputContractEnforcer(deps: OutputContractDeps) {
  const maxRetries = deps.maxRetries ?? 2;
  const retries = new Map<string, number>(); // sessionFile → reminder count

  return function (event: AgentEndEventLike, ctx: OutputContractCtxLike): void {
    if (event.type !== "agent_end") return;
    // Only role sessions (child subagents have parentSession set).
    const sm = ctx?.sessionManager;
    let sessionFile: string | undefined;
    let isRoleSession = false;
    try {
      sessionFile = sm?.getSessionFile?.();
      isRoleSession = !!sm?.getHeader?.()?.parentSession;
    } catch {
      return;
    }
    if (!isRoleSession) return;

    // Did the child call report_role_result? Scan event.messages for the toolCall.
    const messages = event.messages ?? [];
    const calledReport = messages.some(
      (m) => m?.role === "assistant" && (m.content ?? []).some((c) => c?.type === "toolCall" && c?.name === REPORT_TOOL),
    );
    if (calledReport) return; // contract satisfied — no reminder needed.

    const count = retries.get(sessionFile ?? "") ?? 0;
    if (count >= maxRetries) return; // gave up after maxRetries — let extractReportPayload finalText fallback handle it.
    retries.set(sessionFile ?? "", count + 1);

    try {
      deps.sendReminder(REMINDER_TEXT);
    } catch {
      // best-effort: a reminder failure doesn't crash agent_end. extractReportPayload
      // still recovers whatever the child produced.
    }
  };
}
