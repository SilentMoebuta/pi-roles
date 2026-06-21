import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverRoleSkillDirs } from "../src/subagent/role-skills-discovery";

// PM-CORE-1: roleSkillsDirs was hardcoded to 5 role names in spawn-role-tool.ts
// + dag-execute-tool.ts, so adding a 6th role (pm) required editing both arrays.
// The dynamic-scan helper replaces both — any roles/*-skills/ dir is auto-discovered.
// This test proves a NEW (synthetic) skills dir is found without code changes.

describe("discoverRoleSkillDirs (PM-CORE-1 dynamic scan)", () => {
  let tmpRoot: string;
  const setup = () => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-roles-skills-")); return tmpRoot; };
  const teardown = () => fs.rmSync(tmpRoot, { recursive: true, force: true });

  it("discovers *-skills subdirectories dynamically", () => {
    setup();
    try {
      fs.mkdirSync(path.join(tmpRoot, "researcher-skills"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "planner-skills"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "pm-skills"), { recursive: true });
      // A non-skills dir must be ignored.
      fs.mkdirSync(path.join(tmpRoot, "coder.md.d"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "coder.md"), "not a dir");

      const dirs = discoverRoleSkillDirs(tmpRoot).sort();
      assert.deepEqual(dirs, ["planner-skills", "pm-skills", "researcher-skills"]);
    } finally { teardown(); }
  });

  it("returns [] for a missing/empty roles dir (no crash)", () => {
    setup();
    try {
      assert.deepEqual(discoverRoleSkillDirs(path.join(tmpRoot, "does-not-exist")), []);
      fs.mkdirSync(path.join(tmpRoot, "empty"), { recursive: true });
      assert.deepEqual(discoverRoleSkillDirs(path.join(tmpRoot, "empty")), []);
    } finally { teardown(); }
  });

  it("ignores files named like *-skills (only directories)", () => {
    setup();
    try {
      fs.writeFileSync(path.join(tmpRoot, "fake-skills"), "a file, not a dir");
      assert.deepEqual(discoverRoleSkillDirs(tmpRoot), []);
    } finally { teardown(); }
  });

  it("would auto-discover a future 7th role's skills dir without code change", () => {
    setup();
    try {
      fs.mkdirSync(path.join(tmpRoot, "future-role-skills"), { recursive: true });
      assert.ok(discoverRoleSkillDirs(tmpRoot).includes("future-role-skills"));
    } finally { teardown(); }
  });
});
