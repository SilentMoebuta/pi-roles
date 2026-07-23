import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoleFrontmatter } from "../src/roles";
import { discoverRoleSkillDirs } from "../src/subagent/role-skills-discovery";

// Role-loading smoke test: walks roles/*.md and validates each role file is
// well-formed end-to-end (frontmatter shape, name<->filename match, every
// declared skill resolves to a real SKILL.md on disk). Catches the recurring
// fault class of a new role file whose frontmatter drifts from the loader's
// expectations, or a declared skill whose directory/SKILL.md was never added.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = path.resolve(__dirname, "..", "roles");

const REQUIRED_FIELDS = ["name", "description", "tools", "skills", "maxTurns", "thinkingLevel"] as const;

/** Resolve a declared skill name to its SKILL.md path under roles/<role>-skills/.
 *  Flat layout first (roles/<role>-skills/<skill>/SKILL.md); if absent, recurse
 *  the skills dir (PM nests skills under category subdirs). */
function resolveSkillFile(roleSkillsDir: string, skill: string): string | undefined {
  const flat = path.join(roleSkillsDir, skill, "SKILL.md");
  if (fs.existsSync(flat)) return flat;
  // Recursive fallback: find a SKILL.md whose frontmatter name === skill.
  const found = findSkillByName(roleSkillsDir, skill);
  return found;
}

function findSkillByName(dir: string, skill: string): string | undefined {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return undefined; }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      const skillMd = path.join(full, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        try {
          const raw = fs.readFileSync(skillMd, "utf-8");
          const m = raw.match(/^---\n([\s\S]*?)\n---/);
          if (m) {
            const nameLine = m[1].split("\n").find((l) => /^name:/.test(l));
            const name = nameLine ? nameLine.replace(/^name:\s*/, "").trim() : entry;
            if (name === skill) return skillMd;
          }
        } catch { /* ignore */ }
      }
      // Recurse into category subdirs (no SKILL.md at this level).
      const deeper = findSkillByName(full, skill);
      if (deeper) return deeper;
    }
  }
  return undefined;
}

const roleFiles = fs.readdirSync(ROLES_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(ROLES_DIR, f));

describe("role loading smoke test", () => {
  it("found role files to test", () => {
    assert.ok(roleFiles.length > 0, "no roles/*.md files found");
  });

  for (const file of roleFiles) {
    const base = path.basename(file);
    describe(`role file: ${base}`, () => {
      const role = parseRoleFrontmatter(file);

      it("has all required frontmatter fields", () => {
        const raw = fs.readFileSync(file, "utf-8");
        for (const field of REQUIRED_FIELDS) {
          assert.ok(
            new RegExp(`^${field}:`, "m").test(raw),
            `missing required field: ${field} in ${base}`,
          );
        }
      });

      it("name is non-empty string and matches filename (report-writer.md -> report-writer)", () => {
        assert.equal(typeof role.name, "string", "name is not a string");
        assert.ok(role.name.length > 0, "name is empty");
        const expected = base.replace(/\.md$/, "");
        assert.equal(role.name, expected, `name "${role.name}" != filename "${expected}"`);
      });

      it("every declared skill resolves to a SKILL.md on disk", () => {
        const roleSkillsDir = path.join(ROLES_DIR, `${role.name}-skills`);
        assert.ok(
          fs.existsSync(roleSkillsDir) && fs.statSync(roleSkillsDir).isDirectory(),
          `skills dir missing: roles/${role.name}-skills/`,
        );
        for (const skill of role.skills) {
          const resolved = resolveSkillFile(roleSkillsDir, skill);
          assert.ok(
            resolved,
            `skill "${skill}" declared in ${base} has no SKILL.md under roles/${role.name}-skills/`,
          );
        }
      });
    });
  }

  it("discoverRoleSkillDirs finds all *-skills directories (incl report-writer-skills)", () => {
    const dirs = discoverRoleSkillDirs(ROLES_DIR).sort();
    // Expected = one skills dir per role file with the same basename.
    const expected = roleFiles
      .map((f) => `${path.basename(f, ".md")}-skills`)
      .sort();
    assert.deepEqual(dirs, expected, "discovered skills dirs != one per role file");
    assert.ok(dirs.includes("report-writer-skills"), "report-writer-skills not discovered");
  });
});
