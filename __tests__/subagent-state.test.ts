import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentState } from "../src/subagent/state";

// Tests the pure state machine for a subagent run. No pi dependency.
// Principle enforced (see state.ts header): status derives ONLY from runtime
// transitions, never from parsing model/assistant text.

describe("SubagentState", () => {
  it("starts queued with no result/error/timestamps", () => {
    const s = new SubagentState();
    assert.equal(s.status, "queued");
    assert.equal(s.result, undefined);
    assert.equal(s.error, undefined);
    assert.equal(s.startedAt, undefined);
    assert.equal(s.completedAt, undefined);
    assert.equal(s.isTerminal(), false);
  });

  it("markRunning transitions queued→running and stamps startedAt", () => {
    const s = new SubagentState();
    const t = 1234;
    s.markRunning(t);
    assert.equal(s.status, "running");
    assert.equal(s.startedAt, t);
    assert.equal(s.isTerminal(), false);
  });

  it("markCompleted sets result + completedAt, status completed (terminal)", () => {
    const s = new SubagentState();
    s.markRunning(1);
    s.markCompleted("done summary", 99);
    assert.equal(s.status, "completed");
    assert.equal(s.result, "done summary");
    assert.equal(s.completedAt, 99);
    assert.equal(s.isTerminal(), true);
  });

  it("markAborted sets completedAt, status aborted (terminal, no result)", () => {
    const s = new SubagentState();
    s.markRunning(1);
    s.markAborted(50);
    assert.equal(s.status, "aborted");
    assert.equal(s.result, undefined);
    assert.equal(s.completedAt, 50);
    assert.equal(s.isTerminal(), true);
  });

  it("markError sets error + completedAt, status error (terminal)", () => {
    const s = new SubagentState();
    s.markRunning(1);
    s.markError("boom", 77);
    assert.equal(s.status, "error");
    assert.equal(s.error, "boom");
    assert.equal(s.completedAt, 77);
    assert.equal(s.isTerminal(), true);
  });

  it("throws on illegal transitions (can't leave a terminal state)", () => {
    const s = new SubagentState();
    s.markRunning(1);
    s.markCompleted("x", 2);
    assert.throws(() => s.markRunning(3));
    assert.throws(() => s.markCompleted("y", 4));
    assert.throws(() => s.markAborted(5));
    assert.throws(() => s.markError("z", 6));
  });

  it("throws if markRunning called without queued state (double-start)", () => {
    const s = new SubagentState();
    s.markRunning(1);
    assert.throws(() => s.markRunning(2));
  });

  it("throws if a terminal transition is attempted without running first", () => {
    const s = new SubagentState();
    assert.throws(() => s.markCompleted("x", 1));
    assert.throws(() => s.markError("e", 1));
    // markAborted is allowed from queued (cancelled before dispatch)
  });

  it("markAborted allowed from queued (cancel-before-dispatch path)", () => {
    const s = new SubagentState();
    s.markAborted(5);
    assert.equal(s.status, "aborted");
    assert.equal(s.completedAt, 5);
    assert.equal(s.isTerminal(), true);
  });

  it("incrementTurnCount removed — turnCount owned by runner outcome, stamped at resolve (see registry tests)", () => {
    assert.ok(true);
  });
});
