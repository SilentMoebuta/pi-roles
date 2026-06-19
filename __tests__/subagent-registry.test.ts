import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentRegistry, type SubagentRecord } from "../src/subagent/registry";
import { SubagentState } from "../src/subagent/state";

// Registry holds live subagent state + a completion promise per id.
// This fixes gotgenes' gap (public getRecord had no promise; callers could only
// poll status). waitForResult(id) returns a promise that resolves with the final
// record when the run reaches a terminal state.

describe("SubagentRegistry", () => {
  it("register creates an entry; getRecord returns a queued snapshot", () => {
    const r = new SubagentRegistry();
    const id = r.register();
    const rec = r.getRecord(id);
    assert.ok(rec);
    assert.equal(rec!.id, id);
    assert.equal(rec!.status, "queued");
    assert.equal(rec!.turnCount, 0);
  });

  it("getRecord returns undefined for unknown id", () => {
    const r = new SubagentRegistry();
    assert.equal(r.getRecord("nope"), undefined);
  });

  it("resolve(completed) settles waitForResult with the completed record", async () => {
    const r = new SubagentRegistry();
    const id = r.register();
    const state = r.stateOf(id)!;
    state.markRunning(1);
    const p = r.waitForResult(id);
    r.resolve(id, (s) => s.markCompleted("final summary", 99));
    const rec = await p;
    assert.equal(rec.status, "completed");
    assert.equal(rec.result, "final summary");
    assert.equal(rec.completedAt, 99);
  });

  it("resolve(aborted) settles waitForResult with aborted record", async () => {
    const r = new SubagentRegistry();
    const id = r.register();
    r.stateOf(id)!.markRunning(1);
    const p = r.waitForResult(id);
    r.resolve(id, (s) => s.markAborted(50));
    const rec = await p;
    assert.equal(rec.status, "aborted");
    assert.equal(rec.result, undefined);
  });

  it("resolve(error) settles waitForResult with error record", async () => {
    const r = new SubagentRegistry();
    const id = r.register();
    r.stateOf(id)!.markRunning(1);
    const p = r.waitForResult(id);
    r.resolve(id, (s) => s.markError("boom", 7));
    const rec = await p;
    assert.equal(rec.status, "error");
    assert.equal(rec.error, "boom");
  });

  it("reject propagates through waitForResult (runner threw)", async () => {
    const r = new SubagentRegistry();
    const id = r.register();
    const p = r.waitForResult(id);
    r.reject(id, new Error("runner crashed"));
    await assert.rejects(() => p, /runner crashed/);
  });

  it("resolve throws if called twice (one terminal transition per run)", () => {
    const r = new SubagentRegistry();
    const id = r.register();
    r.stateOf(id)!.markRunning(1);
    r.resolve(id, (s) => s.markAborted(2));
    assert.throws(() => r.resolve(id, (s) => s.markCompleted("x", 3)));
  });

  it("getRecord reflects turnCount stamped at resolve (count owned by runner outcome)", () => {
    const r = new SubagentRegistry();
    const id = r.register();
    r.stateOf(id)!.markRunning(1);
    // before resolve: turnCount 0 (live progress not surfaced; runner owns the count privately)
    assert.equal(r.getRecord(id)!.turnCount, 0);
    r.resolve(id, (s) => s.markCompleted("x", 2), undefined, 5);
    assert.equal(r.getRecord(id)!.turnCount, 5);
  });

  it("listAgents returns all registered ids", () => {
    const r = new SubagentRegistry();
    const a = r.register();
    const b = r.register();
    const c = r.register();
    assert.deepEqual(r.listAgents().sort(), [a, b, c].sort());
  });

  it("hasRunning is true while a non-terminal run exists, false otherwise", () => {
    const r = new SubagentRegistry();
    assert.equal(r.hasRunning(), false);
    const id = r.register();
    r.stateOf(id)!.markRunning(1);
    assert.equal(r.hasRunning(), true);
    r.resolve(id, (s) => s.markCompleted("x", 2));
    assert.equal(r.hasRunning(), false);
  });
});
