# Plan: `/role` in-place persona switching for the main agent

## Objective (from goal)
`/role <name>` makes the main agent adopt a role's persona persistently (session
entry + `before_agent_start` injection); `/role clear` reverts; `/role` shows
current. No subagent spawn, no tool/model/thinkingLevel changes.

## Design decisions (locked via grey-area discussion)
- **灰区 1 = A**: inject preamble + role.md body ONLY. Do not load `*-skills/`
  into the main session (requires `resources_discover` reload — out of scope).
- **灰区 2**: role persona chains AFTER pi-goal governance + superpowers in
  systemPrompt. An active pi-goal does NOT block role switching.
- **灰区 3**: `/role clear` injects one `display:false` steer transition message
  acknowledging prior role context for the default persona's continuity.
- **灰区 4**: on switch (not revert), if `ctx.getContextUsage().percent >= 70`,
  emit `display:true` reminder suggesting fresh conversation; non-blocking;
  skipped when percent null; revert does not remind.

## Mechanism (mirror pi-goal)
- **Write**: `pi.appendEntry<T>("pi-roles:active-role", { action, role })`
  (append-only, last-wins — same as pi-goal `persist()`).
- **Read**: iterate `ctx.sessionManager.getBranch()`, filter
  `entry.type === "custom" && entry.customType === "pi-roles:active-role"`,
  last entry's `data.role` wins (null if action==="clear" or none).
- **Inject**: `pi.on("before_agent_start", ...)` returns
  `{ systemPrompt: event.systemPrompt + "\n\n" + persona }` when activeRole set,
  else returns undefined (natural revert — no snapshot stored).
- **Reconstruct on reload**: `pi.on("session_start", ...)` repopulates the
  closure `activeRole` var from getBranch() (mirrors pi-goal `reconstruct()`).

## Main-session isolation (criterion c0b6064)
Main session has NO `parentSession` header. Existing child-side handlers
(`makeAutoCompactHandler`, `makeOutputContractEnforcer`,
`makeOutputContractProactiveHandler`) all gate on parentSession header → they
do NOT fire for the main session. No change needed to those handlers; verify by
reading their gate conditions.

## Files
| File | Change |
|---|---|
| `src/active-role.ts` (NEW) | Pure helpers: `buildRolePersonaPrompt(role)`, `parseActiveRoleFromBranch(branch)`, `CONTEXT_REMINDER_THRESHOLD=70`, `ACTIVE_ROLE_STORAGE_TYPE`, preamble text. No pi dependency → unit-testable. |
| `src/role-commands.ts` (NEW) | `registerRoleCommands(pi, deps)` where deps = `{ roleRegistry, getActiveRole, setActiveRole, persist }`. Three subcommands: `<name>` / `clear` / (empty → show). Mirrors `pm-commands.ts` structure. |
| `index.ts` | Add closure `let activeRole: string \| null = null`; `reconstructActiveRole(ctx)` on `session_start`; `before_agent_start` handler injecting persona; `registerRoleCommands(pi, {...})` call. Replace the existing "DESCOPED" comment block. |
| `__tests__/active-role.test.ts` (NEW) | `buildRolePersonaPrompt` (preamble present + role body + main-agent note), `parseActiveRoleFromBranch` (last-wins, clear → null, empty → null), threshold constant. |
| `__tests__/role-commands.test.ts` (NEW) | Command logic via mock pi: switch writes entry + sets activeRole; clear nulls + writes clear entry + steer transition; empty shows current; unknown role errors + lists 6 roles; overwrite without clear-first; context reminder ≥70 triggers / null skips / <70 skips / revert skips. |
| `README.md` | Document `/role` alongside the 4 tools. |

## Preamble text (criterion cd7b9a6)
```
You are now operating as the '{role}' role for this conversation.

{role.md body}

Note: You are the MAIN agent, not a spawned subagent. Ignore any references
in the above to report_role_result, being dispatched, or driving subagent
dispatch — those apply only to spawned role subagents. Your tools are the
main session's actual tools (which may differ from the role's declared
tool whitelist). Apply this role's principles and methodology to converse
with the user at depth.
```

## Out of scope (constraints)
- No `*-skills/` loading into main session.
- No tool/model/thinkingLevel changes.
- No original-systemPrompt snapshot.
- No subagent spawn for the main agent.

## Test plan (criterion c028fca)
- Pure-helper tests (no pi mock): persona build, branch parse, threshold.
- Command tests with mock pi capturing `appendEntry` / `sendMessage` calls.
- `before_agent_start` injection test: handler returns systemPrompt containing
  preamble when activeRole set, undefined when null.
- Run full suite: `npx tsx --test __tests__/*.test.ts` — existing tests unregressed.
- `npx tsc --noEmit` exits 0.
