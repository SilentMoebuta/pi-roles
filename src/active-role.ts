// active-role — pure helpers for the /role in-place persona switching feature.
// No pi dependency → unit-testable without mocks. Mirrors pi-goal's
// appendEntry/getBranch persistence pattern (pi-goal extensions/index.ts:563,618)
// but for a single "active role" string (not a full goal snapshot).
//
// Design (locked grey-area decisions, see docs/plans/role-command.md):
//  - Inject preamble + role.md body ONLY (灰区 1 = A). No *-skills/ loading
//    (that needs resources_discover reload — out of scope).
//  - Revert by not-injecting (before_agent_start fires every turn; clearing the
//    entry naturally stops injection next turn — no snapshot stored).
//  - append-only entries, last-wins (set overwrites, clear nulls).

export const ACTIVE_ROLE_STORAGE_TYPE = "pi-roles:active-role";

/** Context-usage percent at/above which a switch suggests a fresh conversation.
 *  Matches makeAutoCompactHandler's default 0.70 threshold for consistency. */
export const CONTEXT_REMINDER_THRESHOLD = 70;

export interface ActiveRoleEntry {
  action: "set" | "clear";
  /** role name for "set"; null for "clear". */
  role: string | null;
}

/** A role whose persona can be injected. RoleDef subset (name + parsed prompt body). */
export interface RolePersona {
  name: string;
  prompt: string;
}

/** Build the persona block to append to the main session's systemPrompt. */
export function buildRolePersonaPrompt(role: RolePersona): string {
  return (
    "\n\n" +
    `You are now operating as the '${role.name}' role for this conversation.\n\n` +
    role.prompt +
    "\n\n" +
    "Note: You are the MAIN agent, not a spawned subagent. Ignore any references " +
    "in the above to report_role_result, being dispatched, or driving subagent " +
    "dispatch — those apply only to spawned role subagents. Your tools are the " +
    "main session's actual tools (which may differ from the role's declared " +
    "tool whitelist). Apply this role's principles and methodology to converse " +
    "with the user at depth."
  );
}

/** A branch entry as exposed by SessionManager.getBranch(). Loose shape — the
 *  real type is wider, but we only read these three fields. */
interface BranchEntry {
  type?: string;
  customType?: string;
  data?: ActiveRoleEntry;
}

/** Read the active role name from a session branch (last-wins). Returns null if
 *  no entry exists or the last relevant entry was a "clear". */
export function parseActiveRoleFromBranch(branch: BranchEntry[]): string | null {
  let active: string | null = null;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ACTIVE_ROLE_STORAGE_TYPE) continue;
    const data = entry.data;
    if (!data) continue;
    if (data.action === "set" && data.role) active = data.role;
    else if (data.action === "clear") active = null;
  }
  return active;
}
