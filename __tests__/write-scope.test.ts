import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeWriteScope, scopesOverlap, WriteScopeLeases } from "../src/dag/scope";
import { validateDAG } from "../src/dag/validate";

describe("write scope normalization", () => {
  it("normalizes repo-relative literal paths and terminal recursive scopes", () => {
    assert.equal(normalizeWriteScope("src"), "src");
    assert.equal(normalizeWriteScope("./src/index.ts"), "src/index.ts");
    assert.equal(normalizeWriteScope("src/core/../index.ts"), "src/index.ts");
    assert.equal(normalizeWriteScope("src/**"), "src");
    assert.equal(normalizeWriteScope("./src/core/**"), "src/core");
    assert.equal(normalizeWriteScope("./**"), ".");
  });

  it("rejects absolute paths, repository escapes, and non-terminal glob forms", () => {
    const rejected = [
      "/tmp/file.ts",
      "C:\\tmp\\file.ts",
      "C:tmp/file.ts",
      "../outside",
      "src/../../outside",
      "src/*",
      "src/**/file.ts",
      "src/***",
      "src/file?.ts",
      "src/[ab].ts",
      "src/{a,b}.ts",
      "src/@(a|b).ts",
      "src/foo@(a|b).ts",
      "src/foo!(a|b).ts",
      "**",
    ];
    for (const scope of rejected) {
      assert.throws(() => normalizeWriteScope(scope), Error, scope);
    }
  });

  it("reports invalid scopes during DAG preflight", () => {
    const result = validateDAG({ nodes: {
      valid: { task: "valid", write_scope: ["src/**"] },
      invalid: { task: "invalid", write_scope: ["docs/*.md"] },
    }});
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /only supports literal paths or a terminal '\/\*\*'/);
  });
});

describe("write scope overlap and leases", () => {
  it("detects file and recursive-directory conflicts without prefix false positives", () => {
    assert.equal(scopesOverlap("src/index.ts", "src/**"), true);
    assert.equal(scopesOverlap("src/core/file.ts", "./src/core/**"), true);
    assert.equal(scopesOverlap("src/index.ts", "src/index.ts"), true);
    assert.equal(scopesOverlap("src/index.ts", "src2/**"), false);
    assert.equal(scopesOverlap("src/a.ts", "src/ab.ts"), false);
    assert.equal(scopesOverlap("./**", "docs/readme.md"), true);
  });

  it("keeps legacy plain-directory scopes recursive", () => {
    assert.equal(scopesOverlap("src", "src/core/index.ts"), true);
    assert.equal(scopesOverlap("src", "scripts/index.ts"), false);
  });

  it("canonicalizes scopes acquired directly by the lease manager", () => {
    const leases = new WriteScopeLeases();
    assert.equal(leases.acquire("writer", ["src/**"]), true);
    assert.equal(leases.canAcquire(["src/core/index.ts"]), false);
    assert.equal(leases.canAcquire(["docs/**"]), true);
    leases.release("writer");
    assert.equal(leases.acquire("next", ["src/core/index.ts"]), true);
  });
});
