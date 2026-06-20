import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnRoleTool, type SpawnToolDeps } from "../src/subagent/spawn-role-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// T3-4: the P0-1 synthetic-message inject path. spawn_role background mode
// wires onComplete → deps.notifyParent(text). The approver found this path was
// UNTESTED AND that index.ts's `pi.sendUserMessage(text)` (no options) THROWS
// when the parent is streaming → swallowed → notification DROPPED. The fix uses
// {deliverAs:'steer'}. This test guards the tool→notifyParent wiring (the
// index.ts deliverAs:'steer' change is a 1-liner verified by code review).

function role(name: string): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 25, canSpawn: false, teammates: [] };
}

function deps(opts: { notifyParent?: (text: string) => void } = {}): { tool: any } {
  const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
  const d: SpawnToolDeps = {
    roleRegistry: new Map([["coder", role("coder")]]),
    service: {
      spawn: (p: any) => {
        // Mirror real service: fire onComplete asynchronously after spawn returns.
        if (p.onComplete) {
          const onComplete = p.onComplete;
          setImmediate(() => onComplete({ id: "bg1", status: "completed", result: "done", turnCount: 1, reportPayload: { findings: ["f"], artifacts: [] }, sessionFile: "/tmp/bg1.jsonl" }));
        }
        return "bg1";
      },
      waitForResult: async () => ({ id: "bg1", status: "completed", result: "done", turnCount: 1, reportPayload: { findings: ["f"], artifacts: [] } }),
      getRecord: () => ({ id: "bg1", status: "completed", turnCount: 1 } as any),
      abort: () => true,
      getAbortController: () => ({ abort: () => {} }),
    },
    reportState,
    getCallerParentSession: () => undefined,
    getCallerSessionFile: () => "/tmp/caller.jsonl",
    now: () => 1000,
    notifyParent: opts.notifyParent,
  };
  return { tool: makeSpawnRoleTool(d) };
}

describe("spawn_role — notifyParent wiring (T3-4)", () => {
  it("background completion calls deps.notifyParent with a completion message", async () => {
    const notified: string[] = [];
    const { tool } = deps({ notifyParent: (text) => notified.push(text) });
    const out = await tool.execute("tc1", { role: "coder", task: "bg work", mode: "background" }, undefined, undefined, {});
    assert.equal((out as any).details.status, "running");
    await new Promise((r) => setImmediate(r));
    assert.equal(notified.length, 1, "notifyParent called once on background completion");
    assert.match(notified[0], /Background task bg1.*completed/i, "notifyParent text describes the completed background task");
  });

  it("foreground mode does NOT call notifyParent (only background notifies)", async () => {
    const notified: string[] = [];
    const { tool } = deps({ notifyParent: (text) => notified.push(text) });
    await tool.execute("tc1", { role: "coder", task: "fg work" }, undefined, undefined, {});
    assert.equal(notified.length, 0, "foreground mode does not notify parent");
  });
});
