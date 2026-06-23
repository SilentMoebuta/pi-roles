import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeSpawnRoleTool, type SpawnToolDeps, buildInlineRole } from "../src/subagent/spawn-role-tool";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

// Inline roleDef: spawn_role accepts an inline role definition (no disk file,
// no skills dir) for ad-hoc expert dispatch (cce V4-style dynamic experts).
// Constraints (avoid cce V4's debts): canSpawn default false (anti-cascade),
// skills forced [] (no disk dir for ad-hoc roles), tools whitelist enforced.

interface FakeRec { id: string; status: string; result?: string; turnCount: number; }

function fakeService(rec: Partial<FakeRec> = { id: "r1", status: "completed", result: "done", turnCount: 1 }) {
  const calls: any[] = [];
  return {
    calls,
    svc: {
      spawn: (p: any) => { calls.push(p); return rec.id; },
      waitForResult: async (id: string) => ({ id, status: rec.status, result: rec.result, turnCount: rec.turnCount } as any),
      getRecord: (id: string) => ({ id, status: rec.status } as any),
      abort: () => true,
      getAbortController: () => ({ abort: () => {} }),
    },
  };
}

function deps(opts: { svc?: any; reportState?: ReportState } = {}) {
  const roleRegistry = new Map<string, RoleDef>();
  const reportState: ReportState = opts.reportState ?? { reported: new Set(), activeRole: new Map(), payloads: new Map() };
  const d: SpawnToolDeps = {
    roleRegistry,
    service: opts.svc ?? fakeService().svc,
    reportState,
    getCallerParentSession: () => undefined, // main agent (no parent)
    getCallerSessionFile: () => undefined,
    now: () => 1000,
  };
  return { tool: makeSpawnRoleTool(d), deps: d };
}

async function exec(tool: any, params: any, signal?: AbortSignal) {
  return tool.execute("tc1", params, signal, undefined, {});
}

describe("buildInlineRole (unit)", () => {
  it("constructs RoleDef from inline definition with safe defaults", () => {
    const r = buildInlineRole({
      name: "ip-expert",
      description: "临时知识产权专家",
      prompt: "你是知识产权专家...",
      tools: ["read", "bash", "grep"],
    });
    assert.equal(r.name, "ip-expert");
    assert.equal(r.canSpawn, false, "inline role canSpawn defaults false (anti-cascade)");
    assert.deepEqual(r.skills, [], "inline role skills forced [] (no disk dir)");
    assert.deepEqual(r.tools, ["read", "bash", "grep"]);
    assert.equal(r.maxTurns > 0, true, "maxTurns has sensible default");
  });

  it("respects explicit canSpawn=true if caller insists (escape hatch)", () => {
    const r = buildInlineRole({ name: "x", description: "d", prompt: "p", tools: ["read"], canSpawn: true });
    assert.equal(r.canSpawn, true);
  });

  it("respects explicit maxTurns override", () => {
    const r = buildInlineRole({ name: "x", description: "d", prompt: "p", tools: ["read"], maxTurns: 50 });
    assert.equal(r.maxTurns, 50);
  });

  it("forces skills=[] even if caller passes skills (no disk loading for ad-hoc)", () => {
    const r = buildInlineRole({ name: "x", description: "d", prompt: "p", tools: ["read"], skills: ["foo"] } as any);
    assert.deepEqual(r.skills, [], "inline role never loads skills from disk");
  });
});

describe("spawn_role with inline roleDef", () => {
  it("spawns from roleDef when role name omitted; service receives inline role's name+tools", async () => {
    const f = fakeService();
    const { tool } = deps({ svc: f.svc });
    const out = await exec(tool, {
      roleDef: { name: "ip-expert", description: "临时IP专家", prompt: "你是IP专家", tools: ["read", "bash", "grep"] },
      task: "审 IP 条款",
    });
    assert.equal(out.details.status, "completed");
    assert.equal(f.calls[0].role, "ip-expert");
    // report_role_result is force-included (every role must be able to report its structured result)
    assert.deepEqual(f.calls[0].tools, ["read", "bash", "grep", "report_role_result"]);
    assert.equal(f.calls[0].task, "审 IP 条款");
  });

  it("error if both role and roleDef provided (mutually exclusive)", async () => {
    const { tool } = deps();
    const out = await exec(tool, {
      role: "reviewer",
      roleDef: { name: "x", description: "d", prompt: "p", tools: ["read"] },
      task: "t",
    });
    assert.equal(out.details.status, "error");
    assert.match(out.details.error || "", /role.*roleDef|mutually exclusive|not both/i);
  });

  it("inline role is NOT looked up in registry (ad-hoc, no disk file)", async () => {
    const f = fakeService();
    // registry has a 'reviewer' role, but we pass an inline roleDef with a DIFFERENT name
    const roleRegistry = new Map<string, RoleDef>();
    roleRegistry.set("reviewer", { name: "reviewer", description: "d", prompt: "p", tools: ["read"], skills: [], maxTurns: 25, canSpawn: false, teammates: [] });
    const { tool } = deps({ svc: f.svc });
    (tool as any); // tool already bound to empty registry via deps(); passing inline should bypass lookup
    await exec(tool, {
      roleDef: { name: "data-privacy-expert", description: "临时数据隐私专家", prompt: "p", tools: ["read", "web_search"] },
      task: "审数据条款",
    });
    // service got the INLINE name, not a registry lookup
    assert.equal(f.calls[0].role, "data-privacy-expert");
  });
});
