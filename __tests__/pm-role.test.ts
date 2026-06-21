import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoleFrontmatter } from "../src/roles";
import { PM_COMMANDS, registerPmCommands, type PmCommand } from "../src/pm-commands";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// pm role + pm-commands TDD: the role definition parses, the command table
// references real skills, and registerPmCommands registers all commands.

describe("pm role definition (Step 4)", () => {
  it("roles/pm.md parses with valid frontmatter", () => {
    const pmPath = path.join(__dirname, "..", "roles", "pm.md");
    const r = parseRoleFrontmatter(pmPath);
    assert.equal(r.name, "pm");
    assert.ok(r.tools.length >= 8, `pm needs 8+ tools, got ${r.tools.length}`);
    assert.ok(r.skills.length >= 50, `pm needs 50+ skills, got ${r.skills.length}`);
    assert.ok(r.maxTurns >= 25, `pm maxTurns >= 25, got ${r.maxTurns}`);
  });

  it("every skill in pm.md frontmatter has a SKILL.md on disk", () => {
    const pmPath = path.join(__dirname, "..", "roles", "pm.md");
    const r = parseRoleFrontmatter(pmPath);
    const skillsRoot = path.join(__dirname, "..", "roles", "pm-skills");
    for (const skillName of r.skills) {
      // search across all domain dirs for this skill name
      let found = false;
      for (const domain of fs.readdirSync(skillsRoot)) {
        const p = path.join(skillsRoot, domain, skillName, "SKILL.md");
        if (fs.existsSync(p)) { found = true; break; }
      }
      assert.ok(found, `skill '${skillName}' in pm.md frontmatter has no SKILL.md on disk`);
    }
  });
});

describe("pm-commands (Step 4)", () => {
  it("PM_COMMANDS table has 10+ commands", () => {
    assert.ok(PM_COMMANDS.length >= 10, `expected 10+ commands, got ${PM_COMMANDS.length}`);
  });

  it("every command references real skill dirs", () => {
    const skillsRoot = path.join(__dirname, "..", "roles", "pm-skills");
    for (const cmd of PM_COMMANDS) {
      for (const skill of cmd.skills) {
        const p = path.join(skillsRoot, cmd.domain, skill, "SKILL.md");
        assert.ok(fs.existsSync(p),
          `command '${cmd.name}' references skill '${cmd.domain}/${skill}' but SKILL.md not found`);
      }
    }
  });

  it("registerPmCommands registers all commands via pi.registerCommand", () => {
    const registered: string[] = [];
    const mockPi: any = { registerCommand: (name: string, _opts: any) => { registered.push(name); } };
    registerPmCommands(mockPi);
    assert.equal(registered.length, PM_COMMANDS.length,
      `registered ${registered.length} but table has ${PM_COMMANDS.length}`);
    assert.ok(registered.includes("pm-write-prd"), "pm-write-prd should be registered");
    assert.ok(registered.includes("pm-discover"), "pm-discover should be registered");
    assert.ok(registered.includes("pm-strategy"), "pm-strategy should be registered");
  });
});
