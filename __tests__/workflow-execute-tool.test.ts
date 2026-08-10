import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeWorkflowExecuteTool } from "../src/dag/workflow-execute-tool";

describe("workflow_execute tool contract", () => {
  it("rejects invalid workflow before constructing a child", async () => {
    let calls = 0;
    const tool = makeWorkflowExecuteTool({
      roleRegistry: new Map(), service: { spawn: () => { calls++; throw new Error("must not spawn"); } } as any,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: ".", agentDir: ".",
    }) as any;
    const result = await tool.execute("call-1", { workflow: { schemaVersion: 1, id: "bad", kind: "parallel", tasks: [{ id: "a", task: "a" }, { id: "b", task: "b", dependsOn: ["a"] }] } }, new AbortController().signal, () => {}, {});
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "error");
    assert.equal(calls, 0);
  });
});
