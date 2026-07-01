import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagExecuteTool } from "../src/dag/dag-execute-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// P1 (full) live blocker: a routes DAG router could not return `route` because
// the inline roleDef's report_role_result schema only exposed {findings, artifacts}.
// Auto-inject must (a) merge `route` into the router's report schema and (b) append
// a route-contract suffix to the router's task naming the valid keys — and must
// NOT touch non-router nodes.

function fakeService(spawns: Array<{ role: string | undefined; task: string; customTools?: any[] }>) {
  return {
    spawn: (p: any) => { spawns.push({ role: p.role, task: p.task, customTools: p.customTools }); return (p.role ?? "default") + "_id"; },
    waitForResult: async (id: string) => ({ id, status: "completed", result: "ok", turnCount: 1, reportPayload: { findings: [id], artifacts: [], route: "accept" } }),
    getRecord: (id: string) => ({ id, status: "completed", turnCount: 1 } as any),
    getAbortController: () => ({ abort: () => {} }),
    abort: () => true,
  };
}

function reportSchemaOf(spawn: { customTools?: any[] }): any {
  // customTools[0] is the per-node report_role_result tool built by makeReportTool.
  return spawn.customTools?.[0]?.parameters;
}

describe("dag_execute routes auto-contract (P1 full)", () => {
  it("router node: report schema advertises route + task has route contract; leaf node untouched", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const tool = makeDagExecuteTool({
      roleRegistry: new Map<string, RoleDef>(),
      service: svc,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
      cwd: "/tmp", agentDir: "/tmp",
    });

    const result = await tool.execute("tc", {
      spec: { nodes: {
        decide: {
          roleDef: { name: "gate", description: "router", prompt: "p", tools: ["read"] },
          task: "gate decision",
          routes: { accept: ["accept"], revise: ["revise"] },
        },
        accept: {
          roleDef: { name: "accepter", description: "leaf", prompt: "p", tools: ["read"] },
          task: "acknowledge",
          depends_on: ["decide"],
        },
        revise: {
          roleDef: { name: "reviser", description: "leaf", prompt: "p", tools: ["read"] },
          task: "revise work",
          depends_on: ["decide"],
        },
      }},
    }, undefined, undefined, {} as any);

    // Router returned route=accept (fakeService), so accept runs, revise never spawns.
    const details = result.details as any;
    assert.equal(details.status, "completed", `expected completed, got ${JSON.stringify(details).slice(0,200)}`);

    const decideSpawn = spawned.find((s) => s.task.includes("gate decision"))!;
    const acceptSpawn = spawned.find((s) => s.task.includes("acknowledge"))!;

    // (a) router report schema has route (required); (b) router task has the contract suffix
    const decideSchema = reportSchemaOf(decideSpawn);
    assert.equal(decideSchema?.properties?.route?.type, "string", "router report schema advertises route");
    assert.ok(decideSchema?.required?.includes("route"), "route is required in router report schema");
    assert.match(decideSpawn.task, /\[route contract\]/, "router task has route contract suffix");
    assert.match(decideSpawn.task, /"accept"/);
    assert.match(decideSpawn.task, /"revise"/);

    // Leaf node: no route in schema, no suffix in task
    const acceptSchema = reportSchemaOf(acceptSpawn);
    assert.equal(acceptSchema?.properties?.route, undefined, "leaf report schema has NO route");
    assert.doesNotMatch(acceptSpawn.task, /\[route contract\]/, "leaf task has NO route contract suffix");
  });

  it("node WITHOUT routes is a complete no-op (base schema, unchanged task)", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const tool = makeDagExecuteTool({
      roleRegistry: new Map<string, RoleDef>(),
      service: svc,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
      cwd: "/tmp", agentDir: "/tmp",
    });
    await tool.execute("tc2", { spec: { nodes: {
      a: { roleDef: { name: "x", description: "d", prompt: "p", tools: ["read"] }, task: "do a" },
    } } }, undefined, undefined, {} as any);
    const a = spawned[0];
    assert.equal(a.task, "do a", "no suffix appended when routes absent");
    const schema = reportSchemaOf(a);
    assert.equal(schema?.properties?.route, undefined, "no route field when routes absent");
    assert.ok(schema?.properties?.findings && schema?.properties?.artifacts, "default fields present");
  });
});
