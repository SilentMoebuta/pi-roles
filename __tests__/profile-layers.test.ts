import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveProfileLayers, validateProfileLayers, type ProfileLayerV1 } from "../src/profile-layers";

const layers: ProfileLayerV1[] = [
  { schemaVersion: 1, id: "org", scope: "organization", components: {
    profile: { model: "org-default", budget: 10 }, skills: { common: { enabled: true } },
    mcp: { search: { url: "https://org.example" } }, hooks: { preTool: { audit: { enabled: true } } }, projectPolicy: { network: "ask" },
  }, enforced: { projectPolicy: { network: "deny" } } },
  { schemaVersion: 1, id: "user", scope: "user", components: { profile: { model: "user-choice" }, skills: { personal: { enabled: true } } } },
  { schemaVersion: 1, id: "repo", scope: "repository", components: { profile: { budget: 20 }, projectPolicy: { network: "allow", paths: ["docs/**"] } } },
];

describe("profile layer composition V1", () => {
	it("returns validation diagnostics for malformed external JSON", () => {
		assert.match(validateProfileLayers([{ schemaVersion: 1, id: "bad", scope: "user", components: null } as any]).join(" "), /components must be an object/);
	});
  it("loads profile, skill, MCP, hook, and project policy with deterministic precedence", () => {
    const resolved = resolveProfileLayers(layers);
    assert.deepEqual(resolved.layerIds, ["org", "user", "repo"]);
    assert.deepEqual(resolved.components.profile, { model: "user-choice", budget: 20 });
    assert.equal((resolved.components.skills as any).common.enabled, true);
    assert.equal((resolved.components.skills as any).personal.enabled, true);
    assert.equal((resolved.components.mcp as any).search.url, "https://org.example");
    assert.equal((resolved.components.hooks as any).preTool.audit.enabled, true);
    assert.deepEqual(resolved.components.projectPolicy, { network: "deny", paths: ["docs/**"] });
    assert.equal(resolved.provenance["projectPolicy.network"], "organization_enforced");
  });

  it("can remove a repository project profile without changing the core resolver", () => {
    const withRepo = resolveProfileLayers(layers);
    const withoutRepo = resolveProfileLayers(layers.filter((layer) => layer.scope !== "repository"));
    assert.equal((withRepo.components.profile as any).budget, 20);
    assert.equal((withoutRepo.components.profile as any).budget, 10);
    assert.equal((withoutRepo.components.profile as any).model, "user-choice");
  });

  it("rejects duplicate layers and non-organization enforcement", () => {
    const invalid = validateProfileLayers([
      layers[0],
      { schemaVersion: 1, id: "org", scope: "user", components: {}, enforced: { profile: { model: "forbidden" } } },
    ]);
    assert.match(invalid.join(" "), /duplicated/);
    assert.match(invalid.join(" "), /cannot enforce/);
  });

  it("removes stale nested provenance when a higher layer replaces an object", () => {
    const result = resolveProfileLayers([
      { schemaVersion: 1, id: "org", scope: "organization", components: { profile: { nested: { old: true } } } },
      { schemaVersion: 1, id: "user", scope: "user", components: { profile: { nested: "replacement" } } },
    ]);
    assert.equal(result.provenance["profile.nested.old"], undefined);
    assert.equal(result.provenance["profile.nested"], "user");
  });
});
