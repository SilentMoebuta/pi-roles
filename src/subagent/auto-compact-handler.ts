// makeAutoCompactHandler — P1-5: proactive compaction for role subagents.
//
// The researcher role declares maxTurns:9999 for long research, but pi-roles
// spawned children with no proactive compaction trigger. pi's DEFAULT compaction
// is enabled (children inherit), but it fires REACTIVELY at the overflow threshold
// — a single huge tool_result can overflow the NEXT request before compaction
// runs → provider error → status 'error' → accumulated findings LOST (the cliff).
//
// Fix (per approved plan + researcher verdict, mirroring pi's own
// examples/extensions/trigger-compact.ts): a CHILD-side turn_end handler (gated
// on the parentSession header — the decisive fact that child-side pi.on fires
// for the child) reads ctx.getContextUsage().tokens; when it crosses a
// role-configurable threshold (default 70% of the model's context window), call
// ctx.compact({customInstructions}) BEFORE the overflow cliff. Role-specific
// compaction prompts preserve what matters per role (researcher=citations/findings,
// reviewer=findings+diff, debugger=repro+root-cause).
//
// Graceful degradation: on compaction error, the child still calls
// report_role_result with findings-so-far (ties to P0-4's agent_end reminder).

export interface AutoCompactDeps {
  /** Resolve the role name for the current child session (via the activeRole
   *  map keyed by sessionFile, populated by spawn-role-tool's onSessionCreated).
   *  Returns undefined for the main session (no compaction trigger there —
   *  the main agent manages its own context). */
  getRole: (sessionFile: string | undefined) => string | undefined;
  /** Role-specific compaction prompt. Falls back to a generic preserve-findings
   *  prompt when the role has no specific instructions. */
  getCompactionPrompt?: (role: string) => string | undefined;
  /** The model's context-window size (tokens), for the percentage threshold.
   *  Defaults to 200_000 if unavailable (covers most 2026 frontier models). */
  contextWindow?: number;
  /** Compact at this fraction of contextWindow (default 0.70 — leaves headroom
   *  so a huge tool_result in the next turn doesn't overflow first). */
  thresholdPct?: number;
}

export interface TurnEndEventLike {
  type: "turn_end";
}

/** The ctx passed to a turn_end handler. pi's ExtensionContext provides compact()
 * and getContextUsage(); we read them at call time so the handler is bound to the
 * CHILD's ctx (the child loads its own pi-roles instance — decisive fact). */
export interface AutoCompactCtxLike {
  sessionManager?: { getSessionFile?: () => string | undefined };
  compact?: (opts: { customInstructions?: string; onComplete?: () => void; onError?: (e: Error) => void }) => void;
  getContextUsage?: () => { tokens?: number | null } | null | undefined;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_THRESHOLD_PCT = 0.70;

const ROLE_COMPACTION_PROMPTS: Record<string, string> = {
  researcher: "Preserve ALL citations, tier-1 findings, the research question, and the search/snowball log. Drop raw page text and verbatim quotes over 200 chars.",
  reviewer: "Preserve the findings list (each with severity + file:line) and any diff under review. Drop cited file contents and verbose code listings.",
  debugger: "Preserve the repro steps, the current root-cause hypothesis, and the failing test. Drop explored-but-discarded hypotheses and verbose logs.",
  planner: "Preserve the ADRs and the DAG structure. Drop discarded alternatives and verbose rationale.",
  coder: "Preserve the test list, the RED/GREEN state, and the commit log. Drop applied diffs already committed.",
};

const GENERIC_PROMPT = "Preserve the key findings and any artifacts produced so far. Drop verbose tool output and raw file contents.";

export function makeAutoCompactHandler(deps: AutoCompactDeps) {
  const contextWindow = deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const thresholdPct = deps.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const threshold = Math.floor(contextWindow * thresholdPct);
  let compacting = false; // guard: don't re-trigger while a compaction is in flight

  return function (event: TurnEndEventLike, ctx: AutoCompactCtxLike): void {
    if (event.type !== "turn_end") return;
    // Only role sessions (child subagents have parentSession set). The main
    // agent manages its own context; we don't compact it from here.
    const sm = ctx?.sessionManager;
    let sessionFile: string | undefined;
    let isRoleSession = false;
    try {
      sessionFile = sm?.getSessionFile?.();
      isRoleSession = !!deps.getRole(sessionFile);
    } catch {
      return; // malformed ctx — no-op
    }
    if (!isRoleSession) return;

    const usage = ctx?.getContextUsage?.();
    const tokens = usage?.tokens ?? null;
    if (tokens === null || tokens < threshold) return;
    if (compacting) return; // already compacting this turn — don't stack
    compacting = true;

    const role = deps.getRole(sessionFile) ?? "default";
    const customInstructions =
      deps.getCompactionPrompt?.(role) ?? ROLE_COMPACTION_PROMPTS[role] ?? GENERIC_PROMPT;

    // Graceful degradation: on error, clear the guard so a later turn can retry;
    // the child still calls report_role_result with findings-so-far (P0-4 tie-in).
    ctx?.compact?.({
      customInstructions,
      onComplete: () => { compacting = false; },
      onError: () => { compacting = false; },
    });
  };
}
