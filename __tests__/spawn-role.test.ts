import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnRole, type SpawnContext } from "../src/spawn-role";
import type { RoleDef } from "../src/roles";

type Status = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";

// Mock service: records calls and lets the test drive the record state.
class MockService {
  spawns: { type: string; prompt: string; opts: any }[] = [];
  aborts: string[] = [];
  records = new Map<string, { status: Status; toolUses: number; startedAt: number; completedAt?: number }>();
  spawn(type: string, prompt: string, opts: any = {}): string {
    const id = `agent-${this.spawns.length + 1}`;
    this.spawns.push({ type, prompt, opts });
    this.records.set(id, { status: "running", toolUses: 0, startedAt: Date.now() });
    return id;
  }
  getRecord(id: string) { return this.records.get(id); }
  abort(id: string): boolean { this.aborts.push(id); const r = this.records.get(id); if (r) r.status = "aborted"; return !!r; }
  listAgents() { return []; }
}

function makeRole(name: string, maxTurns = 5): RoleDef {
  return { name, description: name, prompt: "p", tools: [], skills: [], maxTurns };
}

function makeCtx(mock: MockService, opts: { currentDepth?: number; maxDepth?: number; livenessTimeoutMs?: number; now?: () => number } = {}): SpawnContext {
  return {
    getSubagentsService: () => mock,
    currentDepth: opts.currentDepth ?? 0,
    maxDepth: opts.maxDepth ?? 3,
    livenessTimeoutMs: opts.livenessTimeoutMs ?? 300000,
    now: opts.now ?? (() => Date.now()),
    roleRegistry: new Map([["pm", makeRole("pm")]]),
    pollIntervalMs: 0, // run poll loop without real delays in tests
  };
}

describe("spawnRole enforcement", () => {
  it("rejects unknown role", async () => {
    const mock = new MockService();
    const r = await spawnRole("ghost", "t", makeCtx(mock));
    assert.match(r.error!, /unknown role/);
    assert.equal(mock.spawns.length, 0);
  });
  it("rejects when service unavailable", async () => {
    const ctx = makeCtx(new MockService()); ctx.getSubagentsService = () => undefined;
    const r = await spawnRole("pm", "t", ctx);
    assert.match(r.error!, /subagent service/);
  });
  it("rejects when depth exceeded (pre-spawn)", async () => {
    const mock = new MockService();
    const r = await spawnRole("pm", "t", makeCtx(mock, { currentDepth: 3, maxDepth: 3 })); // nextDepth=4 > 3
    assert.match(r.error!, /depth limit/);
    assert.equal(mock.spawns.length, 0);
  });
  it("passes role.maxTurns to spawn options", async () => {
    const mock = new MockService();
    await spawnRole("pm", "do it", makeCtx(mock));
    assert.equal(mock.spawns.length, 1);
    assert.equal(mock.spawns[0].opts.maxTurns, 5); // role maxTurns
  });
  it("aborts when toolUses reaches maxTurns (step limit)", async () => {
    const mock = new MockService();
    // drive the record to toolUses == maxTurns on first poll
    const ctx = makeCtx(mock);
    ctx.onFirstPoll = (id) => { mock.records.get(id)!.toolUses = 5; };
    await spawnRole("pm", "t", ctx);
    assert.deepEqual(mock.aborts, ["agent-1"]);
  });
  it("aborts when liveness timeout exceeded", async () => {
    const mock = new MockService();
    let t = 1000;
    const ctx = makeCtx(mock, { livenessTimeoutMs: 5000 });
    ctx.now = () => t;
    // Align startedAt with the controlled clock domain (mock spawn used real Date.now()).
    ctx.onFirstPoll = (id) => { mock.records.get(id)!.startedAt = t; t = 1000 + 6000; }; // jump time past timeout, still running
    await spawnRole("pm", "t", ctx);
    assert.deepEqual(mock.aborts, ["agent-1"]);
  });
  it("does NOT abort when agent completes within limits", async () => {
    const mock = new MockService();
    const ctx = makeCtx(mock);
    ctx.onFirstPoll = (id) => { mock.records.get(id)!.status = "completed"; mock.records.get(id)!.completedAt = Date.now(); };
    const r = await spawnRole("pm", "t", ctx);
    assert.equal(r.error, undefined);
    assert.deepEqual(mock.aborts, []);
  });
  it("returns an error (not silent success) for a still-running agent at pollIntervalMs<=0", async () => {
    const mock = new MockService();
    const ctx = makeCtx(mock); // pollIntervalMs=0, no onFirstPoll → stays running
    const r = await spawnRole("pm", "t", ctx);
    assert.match(r.error!, /non-positive pollIntervalMs/);
    assert.equal(r.agentId, undefined);
    assert.deepEqual(mock.aborts, []); // not aborted, just refused
  });
  it("aborts the spawned child and returns an error when the caller signal is already aborted", async () => {
    const mock = new MockService();
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx(mock);
    ctx.signal = ac.signal;
    ctx.onFirstPoll = (id) => { mock.records.get(id)!.status = "completed"; };
    const r = await spawnRole("pm", "t", ctx);
    assert.match(r.error!, /aborted by caller signal/);
    assert.deepEqual(mock.aborts, ["agent-1"]);
  });
  it("aborts the spawned child when the signal aborts mid-poll", async () => {
    const mock = new MockService();
    const ac = new AbortController();
    const ctx = makeCtx(mock);
    ctx.signal = ac.signal;
    ctx.pollIntervalMs = 5;
    // agent stays running; abort after the first poll iteration
    ctx.onFirstPoll = () => { setTimeout(() => ac.abort(), 1); };
    const r = await spawnRole("pm", "t", ctx);
    assert.match(r.error!, /aborted by caller signal/);
    assert.deepEqual(mock.aborts, ["agent-1"]);
  });
});
