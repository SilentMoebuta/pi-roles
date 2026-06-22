import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_ROLE_STORAGE_TYPE,
  CONTEXT_REMINDER_THRESHOLD,
  buildRolePersonaPrompt,
  parseActiveRoleFromBranch,
} from "../src/active-role";

describe("active-role helpers", () => {
  describe("buildRolePersonaPrompt", () => {
    it("includes preamble declaring MAIN agent (not subagent)", () => {
      const p = buildRolePersonaPrompt({ name: "pm", prompt: "You are a PM." });
      assert.ok(p.includes("'pm'"), "preamble names the role");
      assert.ok(p.includes("MAIN agent"), "declares MAIN agent");
      assert.ok(p.includes("not a spawned subagent"), "distinguishes from subagent");
      assert.ok(p.includes("report_role_result"), "tells model to ignore report_role_result refs");
    });
    it("includes the role body verbatim", () => {
      const p = buildRolePersonaPrompt({ name: "researcher", prompt: "Investigate and report." });
      assert.ok(p.includes("Investigate and report."), "role body present");
    });
    it("starts with a blank-line separator (chains onto existing systemPrompt)", () => {
      const p = buildRolePersonaPrompt({ name: "coder", prompt: "Write code." });
      assert.ok(p.startsWith("\n\n"), "leading separator for clean chaining");
    });
  });

  describe("parseActiveRoleFromBranch", () => {
    it("returns null for empty branch", () => {
      assert.equal(parseActiveRoleFromBranch([]), null);
    });
    it("returns the role from a single set entry", () => {
      const branch = [
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "pm" } },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), "pm");
    });
    it("last-wins when multiple set entries (overwrite without clear-first)", () => {
      const branch = [
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "pm" } },
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "researcher" } },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), "researcher");
    });
    it("clear entry nulls the active role (revert)", () => {
      const branch = [
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "pm" } },
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "clear", role: null } },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), null);
    });
    it("set-after-clear re-activates", () => {
      const branch = [
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "pm" } },
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "clear", role: null } },
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: { action: "set", role: "reviewer" } },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), "reviewer");
    });
    it("ignores other customTypes (no cross-talk with pi-goal etc.)", () => {
      const branch = [
        { type: "custom", customType: "pi-goal", data: { action: "set", role: "pm" } },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), null);
    });
    it("ignores non-custom entries", () => {
      const branch = [{ type: "user", customType: undefined, data: undefined }] as any;
      assert.equal(parseActiveRoleFromBranch(branch), null);
    });
    it("ignores entries with missing data", () => {
      const branch = [
        { type: "custom", customType: ACTIVE_ROLE_STORAGE_TYPE, data: undefined },
      ] as any;
      assert.equal(parseActiveRoleFromBranch(branch), null);
    });
  });

  describe("constants", () => {
    it("CONTEXT_REMINDER_THRESHOLD is 70 (matches auto-compact-handler default)", () => {
      assert.equal(CONTEXT_REMINDER_THRESHOLD, 70);
    });
    it("ACTIVE_ROLE_STORAGE_TYPE is namespaced pi-roles:active-role", () => {
      assert.equal(ACTIVE_ROLE_STORAGE_TYPE, "pi-roles:active-role");
    });
  });
});
