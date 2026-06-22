import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagExecuteTool } from "../src/dag/dag-execute-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// Gap A: dag_execute tool — verifies the tool accepts a DAGSpec, wires through
// the SpawnFn adapter with role resolution, and returns a DAGResult.

function role(name: string, over: Partial<RoleDef> = {}): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 10, canSpawn: false, teammates: [], ...over };
}

function fakeService(spawns: Array<{ role: string | undefined; task: string; tools?: string[]; customTools?: unknown[] }>) {
  return {
    spawn: (p: any) => {
      spawns.push({ role: p.role, task: p.task, tools: p.tools, customTools: p.customTools });
      return (p.role ?? "default") + "_" + (p.task ?? "?");
    },
    waitForResult: async (id: string) => ({ id, status: "completed", result: "ok", turnCount: 1, reportPayload: { findings: [`${id}-output`], artifacts: [`/${id}.ts`] } }),
    getRecord: (id: string) => ({ id, status: "completed", turnCount: 1 } as any),
    getAbortController: () => ({ abort: () => {} }),
    abort: () => true,
  };
}

describe("dag_execute tool (Gap A)", () => {
  it("accepts a static DAGSpec and returns a DAGResult", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("coder", role("coder", { tools: ["read", "bash", "write"] }));
    roleRegistry.set("reviewer", role("reviewer", { tools: ["read", "bash", "grep"] }));
    const reportState: ReportState = { reported: new Set(), activeRole: new Map(), payloads: new Map() };
    const tool = makeDagExecuteTool({ roleRegistry, service: svc, reportState, cwd: "/tmp", agentDir: "/tmp" });

    const result = await tool.execute("tc1", {
      spec: { nodes: {
        auth: { role: "coder", task: "[node:auth] write auth" },
        login: { role: "coder", task: "[node:login] write login" },
        review: { role: "reviewer", task: "[node:review] review", depends_on: ["auth", "login"] },
      }},
    }, undefined, undefined, {} as any);

    const details = result.details as any;
    assert.equal(details.status, "completed");
    assert.equal(details.waves.length, 2, "wave0: auth+login, wave1: review");
    assert.equal(spawned.length, 3, "3 spawns total");
    // Verify role resolution: childTools include report_role_result
    for (const s of spawned) {
      assert.ok(s.tools?.includes("report_role_result"), `spawn for ${s.role} includes report_role_result in childTools`);
      assert.ok(s.customTools?.length > 0, `spawn for ${s.role} has customTools (report_role_result registered as tool)`);
    }
  });

  it("empty DAG returns {status:'failed', reason:'empty DAG'}", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const tool = makeDagExecuteTool({ roleRegistry: new Map(), service: svc, reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: "/tmp", agentDir: "/tmp" });
    const result = await tool.execute("tc1", { spec: { nodes: {} } }, undefined, undefined, {} as any);
    assert.equal((result.details as any).status, "failed");
    assert.match((result.details as any).reason, /empty/);
    assert.equal(spawned.length, 0);
  });

  it("accepts a node with role OMITTED (default subagent, no persona)", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const tool = makeDagExecuteTool({ roleRegistry: new Map([["coder", role("coder")]]), service: svc, reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: "/tmp", agentDir: "/tmp" });
    // Node 'a' has NO role field — schema must accept it (role is Optional now).
    const result = await tool.execute("tc-nr", { spec: { nodes: { a: { task: "do a" } } } }, undefined, undefined, {} as any);
    assert.equal((result.details as any).status, "completed", "role-less node ran to completion");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].role, undefined, "spawn called with role undefined (default subagent)");
    // Default tool set (read/bash/write/edit/grep/find/ls + report_role_result), NOT a role whitelist.
    assert.ok(spawned[0].tools.includes("write"), "default tool set includes write (not role-restricted)");
    assert.ok(spawned[0].tools.includes("report_role_result"), "report_role_result force-included");
  });

  it("mixed DAG: role-less + role-bearing nodes coexist", async () => {
    const spawned: any[] = [];
    const svc = fakeService(spawned);
    const tool = makeDagExecuteTool({ roleRegistry: new Map([["reviewer", role("reviewer", { tools: ["read", "bash", "grep"] })]]), service: svc, reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() }, cwd: "/tmp", agentDir: "/tmp" });
    const result = await tool.execute("tc-mix", { spec: { nodes: {
      a: { task: "do a" },                          // role-less → default tools
      b: { role: "reviewer", task: "review", depends_on: ["a"] },  // role-bearing → whitelist
    } } }, undefined, undefined, {} as any);
    assert.equal((result.details as any).status, "completed");
    assert.equal(spawned.length, 2);
    const aSpawn = spawned.find(s => s.task === "do a")!;
    const bSpawn = spawned.find(s => s.task.startsWith("review"))!;
    assert.equal(aSpawn.role, undefined, "role-less node spawned without role");
    assert.equal(bSpawn.role, "reviewer", "role-bearing node spawned with role");
    assert.ok(aSpawn.tools.includes("write"), "default has write");
    assert.ok(!bSpawn.tools.includes("write"), "reviewer whitelist excludes write");
  });
});
