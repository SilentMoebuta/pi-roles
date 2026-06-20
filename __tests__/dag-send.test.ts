import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Send, DynamicNode, fanOutSends, sendToTask } from "../src/dag/send";
import type { SpawnFn, SpawnHandle } from "../src/dag/executor";

function handle(id: string): SpawnHandle {
  return { agentId: id, wait: async () => ({ status: "completed", reportPayload: { findings: [id], artifacts: [] } }) };
}

describe("dag send — dynamic fan-out", () => {
  it("sendToTask: string arg passes through; object arg is JSON-serialized", () => {
    assert.equal(sendToTask({ role: "coder", arg: "write foo" }), "write foo");
    assert.equal(sendToTask({ role: "coder", arg: { file: "a.ts" } }), JSON.stringify({ file: "a.ts" }));
  });

  it("fanOutSends spawns all Sends in parallel (2-3 Sends, all execute)", async () => {
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (role, task) => {
      spawned.push(`${role}:${task}`);
      // simulate a tick so concurrency is observable
      await new Promise((r) => setTimeout(r, 0));
      return handle(task);
    };
    const sends: Send[] = [
      { role: "coder", arg: "task-A" },
      { role: "coder", arg: "task-B" },
      { role: "coder", arg: "task-C" },
    ];
    const handles = await fanOutSends(sends, spawnFn);
    assert.equal(handles.length, 3);
    assert.deepEqual(spawned.sort(), ["coder:task-A", "coder:task-B", "coder:task-C"]);
  });

  it("a DynamicNode returns Send[] that fan out via fanOutSends", async () => {
    const planner: DynamicNode = async (ctx) => {
      // dynamic decision: spawn N coders based on upstream count
      const n = Object.keys(ctx.dependencies).length > 0 ? 3 : 1;
      return Array.from({ length: n }, (_, i) => ({ role: "coder", arg: `sub-task-${i}` }));
    };
    const sends = await planner({ nodeId: "plan", dependencies: { prep: { status: "completed", result: { findings: ["x"], artifacts: [] } } } });
    assert.equal(sends.length, 3, "3 Sends when dependencies present");
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (role, task) => { spawned.push(task); return handle(task); };
    await fanOutSends(sends, spawnFn);
    assert.deepEqual(spawned.sort(), ["sub-task-0", "sub-task-1", "sub-task-2"]);
  });

  it("fanOutSends uses allSettled — a rejecting Send does NOT abort the others (L2 fix)", async () => {
    const spawnFn: SpawnFn = async (role, task) => {
      if (task === "bad") throw new Error("spawn rejected");
      return handle(task);
    };
    const sends: Send[] = [
      { role: "coder", arg: "ok-1" },
      { role: "coder", arg: "bad" },
      { role: "coder", arg: "ok-2" },
    ];
    const handles = await fanOutSends(sends, spawnFn);
    assert.equal(handles.length, 3);
    assert.equal(handles[0] !== undefined, true, "ok-1 spawned");
    assert.equal(handles[1], undefined, "bad Send → undefined (isolated, not thrown)");
    assert.equal(handles[2] !== undefined, true, "ok-2 still spawned despite bad");
  });
});
