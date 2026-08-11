import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  ROLE_ERROR_CODES,
  ROLE_RESULT_SCHEMA_ID,
  ROLE_RESULT_STATUSES,
} from "../src/role-result";

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
    assert.equal(schema.$id, ROLE_RESULT_SCHEMA_ID);
    assert.deepEqual(schema.properties.status.enum, [...ROLE_RESULT_STATUSES]);
    assert.deepEqual(schema.properties.error.oneOf[1].properties.code.enum, [...ROLE_ERROR_CODES]);
  });

  it("publishes every schema and the stable role-result protocol subpath", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(packageJson.exports["./role-result"], "./src/role-result.ts");
    assert.equal(packageJson.exports["./schemas/*"], "./schemas/*");

    const packed = JSON.parse(execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8" },
    ));
    const inventory = new Set<string>(packed[0].files.map((entry: { path: string }) => entry.path));
    for (const name of [
      "role-result-v1.schema.json", "goal-reviewer-payload-v1.schema.json", "workflow-contract-v1.schema.json",
      "batch-manifest-v1.schema.json", "batch-result-v1.schema.json", "profile-layer-v1.schema.json",
    ]) {
      assert.ok(inventory.has(`schemas/${name}`), `${name} must be included in the npm package`);
    }
  });
});
