// makeOutputContractProactiveHandler — G-OUT-2: proactive output-contract enforcement
// via before_provider_request (the 2nd path, complementing the reactive P0-4
// agent_end enforcer). Verified fact (extensions.md:627 + sdk.js onPayload +
// runner.emitBeforeProviderRequest): pi exposes before_provider_request with
// payload-replace semantics — a handler returning a value REPLACES the provider
// payload. This handler injects `tool_choice: "required"` for role-subagent
// sessions so the model is FORCED to call a tool each turn and cannot text-only-
// finish without calling report_role_result. The reactive enforcer stays as the
// residual safety net for "ended without report".
//
// Gating (mirrors auto-compact-handler P1-5 fix): gate on the session header's
// `parentSession` (set by spawnRole for every child, readable from the child's
// OWN sessionManager) — NEVER force tool_choice on the main agent (it needs
// text-only replies). We deliberately do NOT gate on per-instance reportState
// (the P1-5 trap: the child's active report tool uses spawn-role-tool's
// childReportState, not this instance's module-level reportState, so a
// "reported" check here would be a silent no-op). Forcing "required" on every
// child turn is the simplest reliable form; the post-report extra turn is capped
// by maxTurns and the once-only report tool's terminate-on-duplicate.

export interface BeforeProviderRequestEventLike {
  type: "before_provider_request";
  payload: any;
}

export interface ProactiveCtxLike {
  sessionManager?: {
    /** Session header — present on child subagents (parentSession set by
     *  spawnRole's newSession({parentSession})). Readable from the child's OWN
     *  sessionManager (decisive fact). Used to gate to role sessions ONLY. */
    getHeader?: () => { parentSession?: string } | undefined;
  };
}

export interface OutputContractProactiveDeps {
  /** Override the injected tool_choice (default "required" = force any tool call).
   *  Exposed for tests + future role-specific forcing (e.g. force a specific tool). */
  toolChoice?: string | { type: "function"; function: { name: string } };
}

/** Build a before_provider_request handler that proactively forces a tool call
 *  for role-subagent sessions (G-OUT-2). Returns undefined (no payload change)
 *  for the main session. */
export function makeOutputContractProactiveHandler(deps: OutputContractProactiveDeps = {}) {
  const toolChoice = deps.toolChoice ?? "required";
  return function (event: BeforeProviderRequestEventLike, ctx: ProactiveCtxLike): any {
    // Gate: role subagent sessions only (parentSession header). Never touch the
    // main agent's payload.
    let isChild = false;
    try {
      isChild = !!ctx?.sessionManager?.getHeader?.()?.parentSession;
    } catch {
      return undefined; // malformed ctx — no-op (don't risk breaking the request)
    }
    if (!isChild) return undefined;
    const p = event.payload as any;
    // Some providers reject tool_choice when thinking mode is ACTIVELY enabled
    // (DeepSeek: "Thinking mode does not support this tool_choice"). Skip
    // injection only when thinking is actually on — thinking mode already
    // biases toward tool calls, and the reactive agent_end enforcer (P0-4) stays
    // as the safety net.
    //
    // Field shapes (verified from pi-ai openai-completions.js):
    //   DeepSeek/zai:  payload.thinking = { type: "enabled" | "disabled" }
    //   DeepSeek ALWAYS sets thinking (enabled when reasoningEffort, disabled
    //   otherwise — thinkingLevelMap.off is undefined !== null). So checking
    //   `p.thinking` truthiness would skip ALWAYS — must check type==="enabled".
    //   OpenRouter:   payload.reasoning = { effort: ... } (skip when present).
    //   Known gap: qwen (enable_thinking) not covered — add if it conflicts.
    const thinkingEnabled =
      p?.thinking?.type === "enabled" ||
      p?.reasoning != null;
    if (thinkingEnabled) return undefined;
    // Inject tool_choice — forces the model to call a tool this turn. The payload
    // is replaced (extensions.md:627 payload-replace semantics).
    return { ...p, tool_choice: toolChoice };
  };
}
