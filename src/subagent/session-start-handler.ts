// makeRoleSessionStartHandler — fixes report_role_result visibility in role subagents.
//
// Root cause (memory ebd8381d): createAgentSession applies the tools allowlist
// (initialActiveToolNames) at construction, BEFORE extensions register their tools.
// report_role_result (registered by pi-roles) isn't registered yet at that point, so
// setActiveToolsByName filters it OUT of the active set. By session_start (fired AFTER
// extensions load — agent-session.js:1955 reason:"reload" after getExtensions:1917),
// report_role_result IS registered but still missing from active tools.
//
// Fix: for role sessions (parentSession header present — marks a child subagent),
// additively add report_role_result to the active tools via setActiveTools. This is
// ADDITIVE only — it takes the CURRENT active set (the role's whitelist as applied)
// and adds report_role_result; it does NOT re-derive or replace the whitelist, so
// reviewer stays read-only (no write/edit gained), debugger keeps write/edit, etc.
//
// No cross-session state: the child session loads its own pi-roles instance, whose
// session_start handler runs against the CHILD's pi (getActiveTools/setActiveTools
// operate on the child session). The parentSession header is read from the child's
// own sessionManager — no main-process state needed.

export interface SessionStartDeps {
  getActiveTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;
}

export interface SessionStartEventLike {
  type: "session_start";
  reason: string;
}

/** The tool that must be visible to every role subagent (output contract). */
const REPORT_TOOL = "report_role_result";

export function makeRoleSessionStartHandler(deps: SessionStartDeps) {
  return function (event: SessionStartEventLike, ctx: unknown): void {
    // Only role sessions (child subagents have parentSession set).
    const sm = (ctx as any)?.sessionManager;
    let parentSession: string | undefined;
    try {
      parentSession = sm?.getHeader?.()?.parentSession;
    } catch {
      return; // malformed ctx — no-op (don't crash the session start)
    }
    if (!sm || !parentSession) return; // main agent session — leave untouched

    // Additively ensure report_role_result is active. Does NOT touch any other tool
    // (preserves the role's whitelist integrity — reviewer stays read-only, etc.).
    const active = new Set(deps.getActiveTools());
    if (active.has(REPORT_TOOL)) return; // already visible — idempotent no-op
    active.add(REPORT_TOOL);
    deps.setActiveTools(Array.from(active));
  };
}
