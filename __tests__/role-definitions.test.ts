import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoleFrontmatter } from "../src/roles";

// Loads the actual role files from roles/*.md and verifies:
// 1. All three roles parse with correct name/tools/maxTurns.
// 2. Anti-cascade: no executing role's tool whitelist contains spawn_role.
// 3. Research refinement: no role has ask_user (subagents can't interact with user).
// 4. Executing roles lack write where read-only (reviewer has no write/edit).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rolesDir = path.join(__dirname, "..", "roles");

function loadRoles() {
  const map = new Map<string, ReturnType<typeof parseRoleFrontmatter>>();
  for (const f of fs.readdirSync(rolesDir).filter((x) => x.endsWith(".md"))) {
    const r = parseRoleFrontmatter(path.join(rolesDir, f));
    map.set(r.name, r);
  }
  return map;
}

describe("role definitions (roles/*.md)", () => {
  const roles = loadRoles();

  it("all three roles present: researcher, coder, reviewer", () => {
    assert.ok(roles.has("researcher"), "researcher missing");
    assert.ok(roles.has("coder"), "coder missing");
    assert.ok(roles.has("reviewer"), "reviewer missing");
  });

  it("roles parse with name/description/prompt/tools/maxTurns", () => {
    for (const r of roles.values()) {
      assert.ok(r.name, `${r.name}: name set`);
      assert.ok(r.description, `${r.name}: description set`);
      assert.ok(r.prompt.length > 0, `${r.name}: prompt body present`);
      assert.ok(r.tools.length > 0, `${r.name}: tools non-empty`);
      assert.equal(r.maxTurns, 25, `${r.name}: maxTurns 25`);
      assert.equal(r.canSpawn, false, `${r.name}: canSpawn defaults false`);
      assert.deepEqual(r.teammates, [], `${r.name}: teammates defaults empty`);
    }
  });

  it("anti-cascade: NO executing role has spawn_role in its tool whitelist", () => {
    for (const r of roles.values()) {
      assert.ok(!r.tools.includes("spawn_role"), `${r.name}: must not have spawn_role (would allow cascade)`);
      assert.ok(!r.tools.includes("subagent"), `${r.name}: must not have subagent (legacy spawn tool)`);
    }
  });

  it("research refinement: NO role has ask_user (subagents can't interact with user; goal-mode hang risk)", () => {
    for (const r of roles.values()) {
      assert.ok(!r.tools.includes("ask_user"), `${r.name}: must not have ask_user`);
    }
  });

  it("reviewer is read-only: no write/edit tools", () => {
    const reviewer = roles.get("reviewer")!;
    assert.ok(!reviewer.tools.includes("write"), "reviewer must not write");
    assert.ok(!reviewer.tools.includes("edit"), "reviewer must not edit");
    assert.ok(reviewer.tools.includes("read"), "reviewer can read");
  });

  it("coder has write/edit (implementation role)", () => {
    const coder = roles.get("coder")!;
    assert.ok(coder.tools.includes("write"), "coder can write");
    assert.ok(coder.tools.includes("edit"), "coder can edit");
  });

  it("researcher has web/search tools, no write/edit", () => {
    const researcher = roles.get("researcher")!;
    assert.ok(researcher.tools.includes("web_search"), "researcher can web_search");
    assert.ok(researcher.tools.includes("code_search"), "researcher can code_search");
    assert.ok(!researcher.tools.includes("write"), "researcher read-only");
    assert.ok(!researcher.tools.includes("edit"), "researcher read-only");
  });

  it("spawn_role tool whitelist excludes all role tools (main agent only)", () => {
    // The spawn_role tool is registered globally by pi-roles; it is NOT in any
    // role's createSession allowlist, so role subagents never receive it.
    // (createAgentSession({tools: role.tools}) enables only listed tools.)
    for (const r of roles.values()) {
      assert.ok(!r.tools.includes("spawn_role"), `${r.name}: spawn_role not in allowlist`);
    }
  });
});
