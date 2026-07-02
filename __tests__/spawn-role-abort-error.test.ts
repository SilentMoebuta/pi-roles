import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSpawnError } from "../src/subagent/spawn-role-tool";

// G1 (CLM 二次 live 测试复盘): spawn_role abort error was opaque ("step-limit"),
// causing the main agent to blind-retry without knowing the fix is "raise maxTurns".
// Root cause confirmed: NOT a code bug — step-limit logic is correct; the CLM aborts
// were under-provisioning maxTurns (3-8) for a complex 492-line review task that needs
// many read/grep turns. Fix: surface turnCount + an actionable hint so the caller can
// self-diagnose. Pure fn formatSpawnError(reason, turnCount) is unit-testable directly.

describe("formatSpawnError — G1 actionable abort reason (root cause: opaque error)", () => {
	it("step-limit surfaces maxTurns + turnCount + a hint to raise maxTurns", () => {
		const msg = formatSpawnError("step-limit", 8);
		assert.match(msg, /step-limit/i);
		assert.match(msg, /maxTurns/i, "should name maxTurns so the caller knows the knob");
		assert.match(msg, /8/, "should include the turn count reached");
		assert.match(msg, /raise|more turns|simplif/i, "should hint at the remedy");
	});

	it("doom-loop names the repeated-call pattern so the caller fixes the role task", () => {
		const msg = formatSpawnError("doom-loop", 3);
		assert.match(msg, /doom-loop/i);
		assert.match(msg, /repeat|same tool|fail/i, "should hint the role repeated a failing tool");
	});

	it("liveness hints at a hung provider / oversized task", () => {
		const msg = formatSpawnError("liveness", 0);
		assert.match(msg, /liveness/i);
		assert.match(msg, /hung|no activity|provider|too large|smaller/i);
	});

	it("caller-abort and unknown reasons pass through (no spurious enrichment)", () => {
		assert.equal(formatSpawnError("caller-abort", 0), "caller-abort");
		assert.equal(formatSpawnError(undefined, undefined), "aborted");
		assert.equal(formatSpawnError("some-weird-reason", 1), "some-weird-reason");
	});
});

// Behavior coverage lives in spawn-role-tool.test.ts ("aborted run → ..."), which uses
// the real fakeService + deps shape and now asserts the actionable error content too.
