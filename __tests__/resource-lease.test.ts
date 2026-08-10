import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import { normalizeResourceUri, ResourceLeases, resourcesOverlap } from "../src/dag/resource-lease";

describe("generic DAG resource leases", () => {
  it("normalizes hierarchical resource URIs and rejects unsafe forms", () => {
    assert.equal(normalizeResourceUri("MAILBOX://Ops/customer-42/**").value, "mailbox://ops/customer-42/**");
    assert.throws(() => normalizeResourceUri("docs/**"), /absolute resource URI/);
    assert.throws(() => normalizeResourceUri("https://user@example.test/path"), /credentials/);
    assert.throws(() => normalizeResourceUri("file://repo/../outside/**"), /escapes/);
  });

  it("detects overlap only within the same scheme, authority, and hierarchy", () => {
    assert.equal(resourcesOverlap("file://repo/docs/**", "file://repo/docs/a.md"), true);
    assert.equal(resourcesOverlap("file://repo/docs/**", "file://other/docs/a.md"), false);
    assert.equal(resourcesOverlap("mailbox://ops/customer-1", "mailbox://ops/customer-2"), false);
    const leases = new ResourceLeases();
    assert.equal(leases.acquire("a", ["worktree://repo/feature-a/**"]), true);
    assert.equal(leases.acquire("b", ["worktree://repo/feature-a/src"]), false);
    leases.release("a");
    assert.equal(leases.acquire("b", ["worktree://repo/feature-a/src"]), true);
  });

  it("serializes conflicting external resources inside the ready scheduler", async () => {
    let active = 0;
    let peak = 0;
    const spawn: SpawnFn = async (_role, task) => ({
      agentId: task,
      wait: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: "completed", result: { findings: [task], artifacts: [] } };
      },
    });
    const result = await executeDAGCore({ nodes: {
      first: { task: "first", resource_scope: ["mailbox://ops/customer-42/**"] },
      second: { task: "second", resource_scope: ["mailbox://ops/customer-42/inbox"] },
    } }, spawn, { maxConcurrent: 2 });
    assert.equal(result.status, "completed");
    assert.equal(peak, 1);
  });

  it("maps legacy write_scope into the same file resource namespace", async () => {
    let active = 0;
    let peak = 0;
    const spawn: SpawnFn = async (_role, task) => ({
      agentId: task,
      wait: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { status: "completed", result: { findings: [], artifacts: [] } };
      },
    });
    await executeDAGCore({ nodes: {
      legacy: { task: "legacy", write_scope: ["docs"] },
      generic: { task: "generic", resource_scope: ["file://repo/docs/a.md"] },
    } }, spawn, { maxConcurrent: 2 });
    assert.equal(peak, 1);
  });
});
