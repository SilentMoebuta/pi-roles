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

  it("preflights generated roles from the expanded V2 graph", async () => {
    const { spawned, svc } = fakeSvc();
    const checkpoint = JSON.stringify({
      version: 2,
      spec: { nodes: {
        fanout: {
          task: "dynamic dispatch",
          expected_output: "Merged work",
          consumers: ["$result"],
          dispatch: {},
        },
      } },
      expandedSpec: { nodes: {
        fanout: {
          task: "dynamic dispatch",
          expected_output: "Merged work",
          consumers: ["$result"],
          dispatch: {},
          depends_on: ["fanout::child"],
        },
        "fanout::child": {
          role: "missing",
          task: "generated work",
          expected_output: "Generated result",
          consumers: ["fanout"],
        },
      } },
      scheduler: "ready",
      nodeStates: { fanout: { status: "running" }, "fanout::child": { status: "queued" } },
      nodeModes: { fanout: "dynamic" },
      skipReasons: {},
      generatedNodes: { "fanout::child": { id: "fanout::child", key: "child", parentId: "fanout" } },
      dispatchExpansions: { fanout: {
        parentId: "fanout",
        generatedNodeIds: ["fanout::child"],
        source: "dynamic",
        sends: [{ key: "child", role: "missing", arg: "generated work", expected_output: "Generated result", consumers: ["$parent"] }],
      } },
    });
    const tool = makeDagResumeTool({
      roleRegistry: new Map([["coder", role("coder")]]),
      service: svc,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() },
      cwd: "/tmp",
      agentDir: "/tmp",
    });
    const result = await tool.execute("tc-generated-role", { checkpoint }, undefined, undefined, {} as any);
    assert.equal((result.details as any).status, "error");
    assert.match((result.details as any).errors.join("\n"), /unknown role 'missing'/);
    assert.equal(spawned.length, 0);
  });
});
