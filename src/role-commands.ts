// role-commands — /role slash command for in-place main-agent persona switching.
// Structure mirrors pm-commands.ts, but the handler logic is extracted into a
// pure `handleRoleCommand(args, ctx, deps)` so it is unit-testable without a
// real pi (effects flow through deps callbacks). registerRoleCommands wires it
// to pi.registerCommand.
//
// Design decisions (docs/plans/role-command.md): persona injection only (no
// skills loading), no tool/model/thinkingLevel changes, revert by not-injecting,
// append-only last-wins entries, context reminder ≥70% (non-blocking, null-safe,
// revert-skips), transition steer on clear for continuity.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RoleDef } from "./roles";
import {
  ACTIVE_ROLE_STORAGE_TYPE,
  CONTEXT_REMINDER_THRESHOLD,
  type ActiveRoleEntry,
} from "./active-role";

export interface RoleCommandDeps {
  roleRegistry: Map<string, RoleDef>;
  getActiveRole: () => string | null;
  setActiveRole: (role: string | null) => void;
  appendEntry: (customType: string, data: ActiveRoleEntry) => void;
  sendMessage: (msg: { customType: string; content: string; display: boolean; details?: unknown }, opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) => void;
}

/** Minimal ctx shape needed by the handler (ExtensionCommandContext satisfies this). */
interface CommandCtx {
  getContextUsage?: () => { percent: number | null } | null | undefined;
}

/** Available role names, derived from the registry (no hardcoded list to drift). */
function availableRoles(deps: RoleCommandDeps): string[] {
  return Array.from(deps.roleRegistry.keys()).sort();
}

/** Apply the /role subcommand. Pure-ish: all effects go through deps. Exported for testing. */
export function handleRoleCommand(args: string, ctx: CommandCtx, deps: RoleCommandDeps): void {
  const name = (args || "").trim();

  // /role (no args) → show current
  if (!name) {
    const current = deps.getActiveRole();
    deps.sendMessage(
      {
        customType: "pi-roles:active-role:status",
        content: current ? `Active role: ${current}` : "No active role (default persona).",
        display: true,
      },
      { triggerTurn: false },
    );
    return;
  }

  // /role clear → revert
  if (name === "clear") {
    const previous = deps.getActiveRole();
    deps.setActiveRole(null);
    deps.appendEntry(ACTIVE_ROLE_STORAGE_TYPE, { action: "clear", role: null });
    // 灰区 3: transition steer for the default persona's continuity (only if a role was active).
    if (previous) {
      deps.sendMessage(
        {
          customType: "pi-roles:active-role:transition",
          content: `Reverting from '${previous}' role to default persona. The prior conversation was in the ${previous} context.`,
          display: false,
          details: { from: previous },
        },
        { triggerTurn: false, deliverAs: "steer" },
      );
    }
    deps.sendMessage(
      {
        customType: "pi-roles:active-role:status",
        content: previous ? `Reverted to default persona (was '${previous}').` : "No active role to clear.",
        display: true,
      },
      { triggerTurn: false },
    );
    return;
  }

  // /role <name> → switch
  if (!deps.roleRegistry.has(name)) {
    deps.sendMessage(
      {
        customType: "pi-roles:active-role:error",
        content: `Unknown role '${name}'. Available roles: ${availableRoles(deps).join(", ")}.`,
        display: true,
        details: { requested: name, available: availableRoles(deps) },
      },
      { triggerTurn: false },
    );
    return;
  }

  // 灰区 4: context reminder — switch only, non-blocking, null-safe.
  const usage = ctx.getContextUsage?.();
  const percent = usage?.percent ?? null;
  if (percent !== null && percent >= CONTEXT_REMINDER_THRESHOLD) {
    deps.sendMessage(
      {
        customType: "pi-roles:active-role:reminder",
        content: `⚠️ Context is at ${percent}%. Switching to the '${name}' persona adds its role prompt to every turn. For the cleanest experience with this role, consider starting a fresh conversation (/tree new or /reload). The role will still activate next turn.`,
        display: true,
        details: { percent, role: name },
      },
      { triggerTurn: false },
    );
  }

  deps.setActiveRole(name);
  deps.appendEntry(ACTIVE_ROLE_STORAGE_TYPE, { action: "set", role: name });
  deps.sendMessage(
    {
      customType: "pi-roles:active-role:status",
      content: `Switched to '${name}' persona.`,
      display: true,
      details: { role: name },
    },
    { triggerTurn: false },
  );
}

export function registerRoleCommands(pi: ExtensionAPI, deps: RoleCommandDeps): void {
  const register = (pi as any).registerCommand;
  if (typeof register !== "function") return; // mock pi — skip (loader test)
  register.call(pi, "role", {
    description: "Switch the main agent's persona to a role (/role <name>), revert (/role clear), or show current (/role).",
    handler: async (args: string, ctx: CommandCtx) => {
      handleRoleCommand(args, ctx ?? {}, deps);
    },
  });
}
