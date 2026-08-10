import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("published role result schemas", () => {
  for (const name of ["role-result-v1.schema.json", "goal-reviewer-payload-v1.schema.json", "workflow-contract-v1.schema.json", "batch-manifest-v1.schema.json", "batch-result-v1.schema.json", "profile-layer-v1.schema.json"]) {
    it(`${name} is a Draft 2020-12 schema with a stable id`, () => {
      const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8"));
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.match(schema.$id, /^https:\/\/silentmoebuta\.github\.io\/pi-roles\/schemas\//);
      assert.equal(schema.type, "object");
    });
  }

  it("documents the exact immutable role-result digest envelope fields", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "role-result-v1.schema.json"), "utf8"));
    assert.deepEqual(schema.required, [
      "schemaVersion", "resultId", "agentId", "role", "status", "digest", "payload", "error", "turnCount", "recordedAt",
    ]);
    assert.equal(schema.properties.digest.pattern, "^[0-9a-f]{64}$");
  });
});
