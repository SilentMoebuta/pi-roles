import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SpawnDeps } from "../src/subagent/spawn";

// T3-2: the 4 Maps (registry.entries, handles, children, reportState) only ever
// grew — cleanup() existed but was never called from index.ts, and only touched
// archivedSession files, not the runtime Maps. In a long-lived orchestrator run
// spawning hundreds of role sessions, all four grew without bound. The fix:
// count-based LRU cap on TERMINAL records (configurable, default 1000), evicted
// inline on settle; plus service.cleanup() piggybacks on agent_end to free
// terminal records + archived files sooner. Evict ONLY terminal (never in-flight).

function fastDeps(): SpawnDeps {
  return {
    makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "c", getSessionFile: () => `/tmp/c.jsonl` }) as any,
    createSession: async () => ({
      session: {
        subscribe: () => () => {},
        setActiveToolsByName: () => {},
        abort: () => {},
        prompt: async () => {},
        messages: [],
      } as any,
    }),
  };
}

describe("SubagentsService — bounded Map growth (T3-2)", () => {
  it("terminal records are evicted when the cap is exceeded (cap=3, spawn 5)", async () => {
    const svc = new SubagentsService(fastDeps(), { cwd: "/p", agentDir: "/.pi", maxTerminalRecords: 3 } as any);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(svc.spawn({ role: "coder", task: `t${i}`, maxTurns: 1, livenessMs: 0 } as any));
    }
    await Promise.all(ids.map((id) => svc.waitForResult(id).catch(() => {})));
    // After 5 completions with cap=3, the oldest 2 terminal records were evicted.
    // listAgents returns the surviving ids.
    const survivors = new Set(svc.listAgents());
    assert.ok(survivors.size <= 3, `at most 3 terminal records survive (cap=3), got ${survivors.size}`);
    // The most recent (last 3) should survive; the oldest 2 evicted.
    for (const id of ids.slice(-3)) assert.ok(survivors.has(id), `recent id ${id} survives`);
    for (const id of ids.slice(0, 2)) assert.ok(!survivors.has(id), `oldest id ${id} evicted`);
  });

  it("in-flight records are NEVER evicted (only terminal)", async () => {
    // cap=1, but 2 in-flight (hanging) — neither should be evicted despite cap exceeded.
    const deps: SpawnDeps = {
      makeSessionManager: () => ({ newSession: () => {}, getSessionId: () => "c", getSessionFile: () => "/tmp/c.jsonl" }) as any,
      createSession: async () => ({
        session: {
          subscribe: () => () => {},
          setActiveToolsByName: () => {},
          abort: () => {},
          prompt: async () => { await new Promise(() => {}); }, // hangs forever
          messages: [],
        } as any,
      }),
    };
    const svc = new SubagentsService(deps, { cwd: "/p", agentDir: "/.pi", maxTerminalRecords: 1 } as any);
    const a = svc.spawn({ role: "coder", task: "a", maxTurns: 9999, livenessMs: 0 } as any);
    const b = svc.spawn({ role: "coder", task: "b", maxTurns: 9999, livenessMs: 0 } as any);
    await new Promise((r) => setImmediate(r));
    const survivors = new Set(svc.listAgents());
    assert.ok(survivors.has(a) && survivors.has(b), "both in-flight records survive (never evicted despite cap=1)");
    svc.abort(a); svc.abort(b);
  });
});
