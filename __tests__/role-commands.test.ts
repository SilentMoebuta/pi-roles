import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleRoleCommand,
  registerRoleCommands,
  type RoleCommandDeps,
} from "../src/role-commands";
import { ACTIVE_ROLE_STORAGE_TYPE } from "../src/active-role";
import type { RoleDef } from "../src/roles";

const ALL_ROLES = ["coder", "debugger", "planner", "researcher", "reviewer", "pm"];

function makeRoleDef(name: string): RoleDef {
  return {
    name,
    description: `${name} role`,
    prompt: `You are a ${name}.`,
    tools: [],
    skills: [],
    maxTurns: 25,
    canSpawn: false,
    teammates: [],
  };
}

interface State {
  activeRole: string | null;
  entries: Array<{ customType: string; data: unknown }>;
  messages: Array<{ msg: { customType: string; content: string; display: boolean; details?: unknown }; opts?: { triggerTurn?: boolean; deliverAs?: string } }>;
}

function makeDeps(roles: string[] = ALL_ROLES): { deps: RoleCommandDeps; state: State } {
  const roleRegistry = new Map<string, RoleDef>();
  for (const name of roles) roleRegistry.set(name, makeRoleDef(name));
  const state: State = { activeRole: null, entries: [], messages: [] };
  const deps: RoleCommandDeps = {
    roleRegistry,
    getActiveRole: () => state.activeRole,
    setActiveRole: (r) => { state.activeRole = r; },
    appendEntry: (ct, data) => { state.entries.push({ customType: ct, data }); },
    sendMessage: (msg, opts) => { state.messages.push({ msg, opts }); },
  };
  return { deps, state };
}

function ctxWith(percent: number | null) {
  return { getContextUsage: () => ({ percent }) };
}
const ctxNoUsage = {};
const ctxNullPercent = { getContextUsage: () => ({ percent: null }) };

function findMsg(state: State, customType: string) {
  return state.messages.find(m => m.msg.customType === customType);
}

describe("role-commands", () => {
  describe("/role (no args) — show current", () => {
    it("shows 'No active role' when none set", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("", ctxNoUsage, deps);
      assert.equal(state.entries.length, 0);
      const s = findMsg(state, "pi-roles:active-role:status");
      assert.ok(s);
      assert.match(s!.msg.content, /No active role/);
      assert.equal(s!.opts?.triggerTurn, false);
    });
    it("shows the active role when set", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps); // set pm first
      state.messages.length = 0;
      handleRoleCommand("", ctxNoUsage, deps);
      const s = findMsg(state, "pi-roles:active-role:status");
      assert.match(s!.msg.content, /Active role: pm/);
    });
  });

  describe("/role <name> — switch", () => {
    it("sets activeRole, appends a set entry, sends status (no reminder when percent null)", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps);
      assert.equal(state.activeRole, "pm");
      assert.equal(state.entries.length, 1);
      assert.equal(state.entries[0].customType, ACTIVE_ROLE_STORAGE_TYPE);
      assert.deepEqual(state.entries[0].data, { action: "set", role: "pm" });
      const s = findMsg(state, "pi-roles:active-role:status");
      assert.match(s!.msg.content, /Switched to 'pm'/);
      assert.equal(findMsg(state, "pi-roles:active-role:reminder"), undefined, "no reminder when percent unknown");
    });
    it("overwrites without requiring clear-first", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps);
      handleRoleCommand("researcher", ctxNoUsage, deps);
      assert.equal(state.activeRole, "researcher");
      assert.equal(state.entries.length, 2);
      assert.deepEqual(state.entries[1].data, { action: "set", role: "researcher" });
    });
    it("does not modify the role registry or touch tools/model (deps have no such surface)", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("coder", ctxNoUsage, deps);
      // only appendEntry + sendMessage observed; no setActiveTools/model calls exist in deps
      assert.equal(state.activeRole, "coder");
    });
  });

  describe("/role clear — revert", () => {
    it("nulls activeRole, appends clear entry, sends transition steer + status", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps);
      state.messages.length = 0;
      handleRoleCommand("clear", ctxNoUsage, deps);
      assert.equal(state.activeRole, null);
      assert.deepEqual(state.entries.at(-1), { customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "clear", role: null } });
      const t = findMsg(state, "pi-roles:active-role:transition");
      assert.ok(t, "transition steer sent");
      assert.equal(t!.msg.display, false, "transition is display:false");
      assert.equal(t!.opts?.deliverAs, "steer", "transition delivered as steer");
      assert.match(t!.msg.content, /pm/);
      const s = findMsg(state, "pi-roles:active-role:status");
      assert.match(s!.msg.content, /Reverted to default persona/);
    });
    it("sends no transition steer when nothing was active", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("clear", ctxNoUsage, deps);
      assert.equal(findMsg(state, "pi-roles:active-role:transition"), undefined);
      const s = findMsg(state, "pi-roles:active-role:status");
      assert.match(s!.msg.content, /No active role to clear/);
    });
    it("does NOT trigger the context reminder (revert skips reminder)", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps);
      state.messages.length = 0;
      handleRoleCommand("clear", ctxWith(95), deps); // 95% but revert
      assert.equal(findMsg(state, "pi-roles:active-role:reminder"), undefined, "revert never reminds");
    });
  });

  describe("/role <unknown> — error", () => {
    it("'clear' is always the revert subcommand even if a role named 'clear' exists (subcommand wins)", () => {
      // Documents the precedence: the clear branch is checked before registry lookup.
      const { deps, state } = makeDeps(["coder", "clear"]);
      handleRoleCommand("clear", ctxNoUsage, deps);
      assert.equal(state.activeRole, null, "clear reverts, does not switch to a role named 'clear'");
      assert.equal(findMsg(state, "pi-roles:active-role:error"), undefined, "no error — clear is the subcommand");
    });
    it("emits display:true error listing available roles and writes no entry", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("foo", ctxNoUsage, deps);
      assert.equal(state.entries.length, 0, "no entry written for unknown role");
      assert.equal(state.activeRole, null);
      const e = findMsg(state, "pi-roles:active-role:error");
      assert.ok(e);
      assert.equal(e!.msg.display, true);
      assert.match(e!.msg.content, /Unknown role 'foo'/);
      for (const r of ALL_ROLES) {
        assert.ok(e!.msg.content.includes(r), `error lists role '${r}'`);
      }
      assert.deepEqual((e!.msg.details as any).available, [...ALL_ROLES].sort());
    });
    it("available roles are derived from the registry (no hardcoded drift)", () => {
      const { deps, state } = makeDeps(["coder", "reviewer"]);
      handleRoleCommand("zzz", ctxNoUsage, deps);
      const e = findMsg(state, "pi-roles:active-role:error");
      assert.match(e!.msg.content, /coder, reviewer/);
    });
  });

  describe("context reminder (灰区 4)", () => {
    it("triggers at percent >= 70 and role still activates (non-blocking)", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxWith(70), deps);
      const r = findMsg(state, "pi-roles:active-role:reminder");
      assert.ok(r, "reminder sent at 70%");
      assert.equal(r!.msg.display, true);
      assert.match(r!.msg.content, /70%/);
      assert.match(r!.msg.content, /fresh conversation/);
      // role still activated despite reminder
      assert.equal(state.activeRole, "pm");
      assert.deepEqual(state.entries[0].data, { action: "set", role: "pm" });
    });
    it("triggers above 70 (e.g. 95)", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxWith(95), deps);
      assert.ok(findMsg(state, "pi-roles:active-role:reminder"));
      assert.equal(state.activeRole, "pm");
    });
    it("does NOT trigger below 70", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxWith(69), deps);
      assert.equal(findMsg(state, "pi-roles:active-role:reminder"), undefined);
      assert.equal(state.activeRole, "pm", "role still activates without reminder");
    });
    it("does NOT trigger when percent is null", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNullPercent, deps);
      assert.equal(findMsg(state, "pi-roles:active-role:reminder"), undefined);
      assert.equal(state.activeRole, "pm");
    });
    it("does NOT trigger when getContextUsage is absent", () => {
      const { deps, state } = makeDeps();
      handleRoleCommand("pm", ctxNoUsage, deps);
      assert.equal(findMsg(state, "pi-roles:active-role:reminder"), undefined);
    });
  });

  describe("registerRoleCommands", () => {
    it("registers a single 'role' command via pi.registerCommand", () => {
      const registered: string[] = [];
      const mockPi: any = { registerCommand: (name: string) => { registered.push(name); } };
      const { deps } = makeDeps();
      registerRoleCommands(mockPi, deps);
      assert.deepEqual(registered, ["role"]);
    });
    it("no-op when registerCommand is missing (mock pi)", () => {
      const { deps } = makeDeps();
      registerRoleCommands({} as any, deps); // must not throw
    });
  });
});
