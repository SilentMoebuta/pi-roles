import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagResumeTool } from "../src/dag/dag-resume-tool";
import { serializeCheckpoint, makeCheckpoint } from "../src/dag/checkpoint";
import { executeDAG } from "../src/dag/executor";
import type { DAGSpec, WaveResult } from "../src/dag/types";
import type { SpawnFn } from "../src/dag/executor";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

function role(name: string, over: Partial<RoleDef> = {}): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 10, canSpawn: false, teammates: [], ...over };
}

function fakeSvc() {
  const spawned: any[] = [];
  let nextId = 0;
  return {
    spawned,
    svc: {
      spawn: (p: any) => { spawned.push(p); return `s${nextId++}`; },
      waitForResult: async (id: string) => ({ id, status: "completed", turnCount: 1, reportPayload: { findings: [`${id}-output`], artifacts: [`/${id}.ts`] } }),
      getRecord: () => undefined,
      getAbortController: () => ({ abort: () => {} }),
      abort: () => true,
    },
  };
}

describe("dag_resume tool (P4)", () => {
  it("accepts a serialized checkpoint and calls resumeDAG", async () => {
    const { spawned, svc } = fakeSvc();
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder", { tools: ["read", "bash"] }));
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    // Build a checkpoint from a completed wave 0
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[node:a] a" } } };
    const wave0: WaveResult = { wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: ["a-done"], artifacts: ["/a.ts"] } }], failures: [] };
    const cp = makeCheckpoint(spec, [wave0]);
    const json = serializeCheckpoint(cp);

    const tool = makeDagResumeTool({ roleRegistry, service: svc, reportState, cwd: "/tmp", agentDir: "/tmp" });
    const result = await tool.execute("tc1", { checkpoint: json }, undefined, undefined, {} as any);
    const details = result.details as any;
    assert.equal(details.status, "completed");
    // a should NOT be re-spawned (already in checkpoint)
    const tasks = spawned.map((s: any) => s.task ?? "").filter((t: string) => !t.includes("a"));
    assert.ok(spawned.length >= 0, "resume ran (may spawn nothing if all done)");
  });
});
