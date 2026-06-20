import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SpawnDeps } from "../src/subagent/spawn";

// T3-5: maxConcurrentSpawns was hardcoded to 5 in service.ts. A DAG with
// maxConcurrent=10 still throttled to 5 at the service layer (the service gate
// covers the whole runToCompletion, not just the spawn phase). Make it
// constructor-configurable (default 5) so callers can raise it.

function blockingDeps(): SpawnDeps & { release: (n: number) => void; running: () => number } {
  const prompts: Array<() => void> = [];
  let running = 0;
  return {
    release: (n: number) => { for (let i = 0; i < n && prompts.length; i++) prompts.shift()!(); },
    running: () => running,
    makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "c", getSessionFile: () => "/tmp/c.jsonl" }) as any,
    createSession: async () => {
      running++;
      const session = {
        subscribe: () => () => {},
        setActiveToolsByName: () => {},
        abort: () => {},
        prompt: async () => { await new Promise<void>((r) => prompts.push(r)); running--; },
        messages: [],
      };
      return { session } as any;
    },
  } as any;
}

describe("SubagentsService — maxConcurrentSpawns configurable (T3-5)", () => {
  it("default is 5", () => {
    const svc = new SubagentsService(blockingDeps(), { cwd: "/p", agentDir: "/.pi" });
    assert.equal((svc as any).maxConcurrentSpawns, 5, "default 5");
  });

  it("constructor env.maxConcurrentSpawns overrides the cap; 3rd spawn QUEUES when cap=2", async () => {
    const deps = blockingDeps();
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi", maxConcurrentSpawns: 2 } as any);
    svc.spawn({ role: "coder", task: "a", maxTurns: 100, livenessMs: 0 } as any);
    svc.spawn({ role: "coder", task: "b", maxTurns: 100, livenessMs: 0 } as any);
    svc.spawn({ role: "coder", task: "c", maxTurns: 100, livenessMs: 0 } as any);
    await new Promise((r) => setImmediate(r));
    assert.equal(deps.running(), 2, "only 2 running (cap=2), 3rd queued");
    deps.release(2); // finish the 2 running
    await new Promise((r) => setImmediate(r));
    assert.equal(deps.running(), 1, "3rd spawn now admitted after a slot freed");
    deps.release(1);
  });
});
