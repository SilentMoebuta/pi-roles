import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldAbortForStep, isLivenessTimeout, isDepthExceeded, nextDepth } from "../src/control-plane";

describe("control-plane", () => {
  it("shouldAbortForStep false under limit, true at/over", () => {
    assert.equal(shouldAbortForStep(0, 10), false);
    assert.equal(shouldAbortForStep(9, 10), false);
    assert.equal(shouldAbortForStep(10, 10), true);
    assert.equal(shouldAbortForStep(11, 10), true);
  });
  it("isLivenessTimeout false when within window", () => {
    assert.equal(isLivenessTimeout(Date.now(), 5000), false);
  });
  it("isLivenessTimeout true when exceeded", () => {
    assert.equal(isLivenessTimeout(Date.now() - 6000, 5000), true);
  });
  it("nextDepth increments parent depth", () => {
    assert.equal(nextDepth(0), 1);
    assert.equal(nextDepth(3), 4);
  });
  it("isDepthExceeded false under, true over", () => {
    assert.equal(isDepthExceeded(1, 3), false);
    assert.equal(isDepthExceeded(3, 3), false);
    assert.equal(isDepthExceeded(4, 3), true);
  });
});
