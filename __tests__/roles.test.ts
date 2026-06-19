import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRoleFrontmatter, type RoleDef } from "../src/roles";

describe("roles", () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  function writeRole(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-")); dirs.push(dir);
    const f = path.join(dir, "pm.md"); fs.writeFileSync(f, content, "utf-8"); return f;
  }
  it("parses frontmatter + body", () => {
    const f = writeRole(`---
name: pm
description: Product manager
tools: [read, bash, grep]
skills: [create-prd]
maxTurns: 20
---
You are a PM.`);
    const r = parseRoleFrontmatter(f);
    assert.equal(r.name, "pm");
    assert.equal(r.description, "Product manager");
    assert.deepEqual(r.tools, ["read", "bash", "grep"]);
    assert.deepEqual(r.skills, ["create-prd"]);
    assert.equal(r.maxTurns, 20);
    assert.equal(r.prompt, "You are a PM.");
  });
  it("uses defaults for optional fields", () => {
    const f = writeRole(`---
name: coder
description: coder
---
body`);
    const r = parseRoleFrontmatter(f);
    assert.equal(r.maxTurns, 25); // default
    assert.deepEqual(r.tools, []); // empty = inherit all
    assert.deepEqual(r.skills, []);
  });
});
