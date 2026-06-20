// C4 fix-round (HIGH): dag_resume diverged from dag_execute — it built
// buildSpawnFn(deps) ONCE at registration with NO opts, while dag_execute builds
// buildSpawnFn(deps, {modelRegistry, signal, getCallerSessionFile}) INSIDE execute.
// Resumed DAG children therefore got NO model resolution (role.model ignored),
// NO AbortSignal forwarding (mid-resume ESC didn't cancel in-flight children),
// and NO parentSessionId (didn't join the tree-abort tree). Silent functional
// regression — the existing dag-resume test's fake service didn't track these.
// These tests mirror dag-execute-tool-t1-4.test.ts to prove the fix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagResumeTool } from "../src/dag/dag-resume-tool";
import { serializeCheckpoint, makeCheckpoint } from "../src/dag/checkpoint";
import type { DAGSpec, WaveResult } from "../src/dag/types";
import type { RoleDef } from "../src/roles";
import type { ReportState } from "../src/report-tool";

function role(name: string, over: Partial<RoleDef> = {}): RoleDef {
  return { name, description: name, prompt: "p", tools: ["read", "bash"], skills: [], maxTurns: 10, canSpawn: false, teammates: [], ...over };
}

// Fake service that records each spawn's {signal, model, parentSessionId}.
function recordingService(spawns: any[]) {
  return {
    spawn: (p: any) => {
      spawns.push({ role: p.role, signal: p.signal, model: p.model, parentSessionId: p.parentSessionId });
      return p.role + "_id";
    },
    waitForResult: async (id: string) => ({ id, status: "completed", result: "ok", turnCount: 1, reportPayload: { findings: [id], artifacts: [] } }),
    getRecord: () => ({ status: "completed", turnCount: 1 } as any),
    getAbortController: () => ({ abort: () => {} }),
    abort: () => true,
  };
}

describe("dag_resume — C4: forwards signal + model + parentSessionId (parity with dag_execute T1-4)", () => {
  // Checkpoint: wave 0 completed node "a"; node "b" (depends on a) is pending →
  // resumeDAG spawns "b". We assert "b"'s spawn received signal/model/parentSessionId.
  function freshCheckpointWithADone(): string {
    const spec: DAGSpec = { nodes: { a: { role: "coder", task: "[a] t" }, b: { role: "coder", task: "[b] t", depends_on: ["a"] } } };
    const wave0: WaveResult = { wave: 0, successes: [{ nodeId: "a", status: "completed", result: { findings: ["a"], artifacts: [] } }], failures: [] };
    return serializeCheckpoint(makeCheckpoint(spec, [wave0]));
  }

  it("the tool's AbortSignal is forwarded to resumed children's service.spawn({signal})", async () => {
    const spawns: any[] = [];
    const tool = makeDagResumeTool({
      roleRegistry: new Map([["coder", role("coder")]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
      cwd: "/tmp", agentDir: "/tmp",
    });
    const ac = new AbortController();
    await tool.execute("tc1", { checkpoint: freshCheckpointWithADone() }, ac.signal, undefined, { sessionManager: { getSessionFile: () => "/tmp/caller.jsonl" } } as any);
    assert.ok(spawns.length > 0, "resume must spawn the pending node b");
    for (const s of spawns) {
      assert.equal(s.signal, ac.signal, `resumed spawn for ${s.role} received the tool AbortSignal (was undefined — dag_resume divergence)`);
    }
  });

  it("role.model is resolved via ctx.modelRegistry and forwarded to resumed children", async () => {
    const spawns: any[] = [];
    const fakeModel = { id: "glm-5.2", provider: "ksyun" };
    const modelRegistry = { find: (provider: string, id: string) => (provider === "ksyun" && id === "glm-5.2" ? fakeModel : undefined), getAll: () => [fakeModel] };
    const tool = makeDagResumeTool({
      roleRegistry: new Map([["reviewer", role("reviewer", { model: "ksyun/glm-5.2" })]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
      cwd: "/tmp", agentDir: "/tmp",
    });
    // checkpoint with reviewer node pending (wave 0 empty → resume spawns reviewer)
    const spec: DAGSpec = { nodes: { r: { role: "reviewer", task: "[r] review" } } };
    const cp = serializeCheckpoint(makeCheckpoint(spec, []));
    await tool.execute("tc1", { checkpoint: cp }, undefined, undefined, { modelRegistry } as any);
    assert.ok(spawns.length > 0);
    assert.equal(spawns[0].model, fakeModel, "role.model resolved via ctx.modelRegistry for resumed children (was undefined — dag_resume divergence)");
  });

  it("caller sessionFile is passed as parentSessionId so resumed nodes join the tree-abort tree", async () => {
    const spawns: any[] = [];
    const tool = makeDagResumeTool({
      roleRegistry: new Map([["coder", role("coder")]]),
      service: recordingService(spawns),
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() } as ReportState,
      cwd: "/tmp", agentDir: "/tmp",
    });
    await tool.execute("tc1", { checkpoint: freshCheckpointWithADone() }, undefined, undefined, { sessionManager: { getSessionFile: () => "/tmp/caller.jsonl" } } as any);
    assert.ok(spawns.length > 0);
    assert.equal(spawns[0].parentSessionId, "/tmp/caller.jsonl", "parentSessionId = caller sessionFile for resumed children (was undefined — dag_resume divergence)");
  });
});
