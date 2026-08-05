import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listRoleCatalog, makeListRolesTool } from "../src/role-catalog";
import type { RoleDef } from "../src/roles";

function role(name: string, description = name): RoleDef {
  return {
    name,
    description,
    prompt: "private prompt",
    tools: ["read"],
    skills: [`${name}-skill`],
    maxTurns: 10,
    canSpawn: false,
    teammates: [],
  };
}

describe("role catalog + list_roles", () => {
  it("returns a stable read-only projection sorted by role name", () => {
    const registry = new Map<string, RoleDef>([["reviewer", role("reviewer")], ["coder", role("coder", "writes code")]]);
    const catalog = listRoleCatalog(registry);
    assert.deepEqual(catalog.map((item) => item.name), ["coder", "reviewer"]);
    assert.deepEqual(catalog[0], { name: "coder", description: "writes code", tools: ["read"], skills: ["coder-skill"] });
    assert.ok(!("prompt" in catalog[0]), "private persona prompt is not exposed");
    catalog[0].tools.push("write");
    assert.deepEqual(registry.get("coder")?.tools, ["read"], "returned arrays cannot mutate the registry");
  });

  it("list_roles returns the catalog without mutating state", async () => {
    const registry = new Map<string, RoleDef>([["coder", role("coder")]]);
    const tool = makeListRolesTool(registry);
    const output = await tool.execute("tc", {}, undefined, undefined, {} as any);
    assert.deepEqual((output.details as any).roles, [{ name: "coder", description: "coder", tools: ["read"], skills: ["coder-skill"] }]);
    assert.equal(tool.name, "list_roles");
  });
});
