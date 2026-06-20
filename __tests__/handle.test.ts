import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHandle } from "../src/subagent/handle";

describe("AgentHandle (Phase 5a clone-bug fix)", () => {
  it("is structuredClone-safe — no closures/functions/Promises as instance fields", () => {
    const h = new AgentHandle("sub_1", "reviewer", 4);
    // Before the fix this threw: "() => ({ id, status: \"queued\", turnCount: 0 }) could not be cloned."
    assert.doesNotThrow(() => structuredClone(h));
  });

  it("status()/wait()/terminate() resolve live via the injected service, not captured closures", async () => {
    const h = new AgentHandle("sub_1", "reviewer", 4);
    const svc: any = {
      getRecord: (id: string) => ({ id, status: "completed", turnCount: 3 }),
      waitForResult: async (id: string) => ({ id, status: "completed", result: "ok", turnCount: 3, reportPayload: { findings: ["f1"], artifacts: ["/a.ts"] } }),
      abort: () => true,
    };
    assert.equal(h.status(svc), "completed");
    const r = await h.wait(svc);
    assert.equal(r.status, "completed");
    assert.deepEqual(r.result, { findings: ["f1"], artifacts: ["/a.ts"] });
    assert.equal(h.terminate(svc), true);
  });

  it("status() returns 'queued' when no record yet, 'running' when turnCount>0", () => {
    const h = new AgentHandle("sub_2", "coder", 3);
    const svcNone: any = { getRecord: () => undefined, waitForResult: async () => ({ id: "sub_2", status: "queued", turnCount: 0 }), abort: () => false };
    assert.equal(h.status(svcNone), "queued");
    const svcRun: any = { getRecord: () => ({ id: "sub_2", status: "running", turnCount: 2 }), waitForResult: async () => ({ id: "sub_2", status: "running", turnCount: 2 }), abort: () => false };
    assert.equal(h.status(svcRun), "running");
  });
});
