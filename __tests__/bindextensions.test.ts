import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentsService } from "../src/subagent/service";
import type { SubagentSession } from "../src/subagent/runner";
import type { SpawnDeps } from "../src/subagent/spawn";

// report_role_result visibility fix (root cause: pi-roles spawn path never
// called session.bindExtensions, so the session_start handler that additively
// adds report_role_result to a role session's active tools NEVER fired).
// This test proves the service now calls bindExtensions before prompt — which
// is the precondition for the handler to run. The live "child can actually call
// report_role_result" leg is verified by the goal-session smoke.

function recordingSession(events: string[]): { session: SubagentSession } {
  const listeners: Array<(e: any) => void> = [];
  const session: SubagentSession = {
    subscribe: (l) => { listeners.push(l); return () => {}; },
    setActiveToolsByName: () => {},
    abort: () => {},
    bindExtensions: async (_bindings?: { mode?: string }) => { events.push("bindExtensions"); },
    prompt: async () => {
      events.push("prompt");
      listeners.forEach((l) => l({ type: "agent_end" }));
    },
  };
  return { session };
}

function makeDeps(session: SubagentSession): SpawnDeps {
  return {
    makeSessionManager: () => ({
      newSession: () => {},
      getSessionId: () => "child-id",
      getSessionFile: () => "/tmp/child.jsonl",
    }) as any,
    createSession: async () => ({ session }),
  };
}

describe("report_role_result fix — service calls bindExtensions before prompt", () => {
  it("bindExtensions is called BEFORE prompt (so session_start handler fires and adds report_role_result)", async () => {
    const events: string[] = [];
    const { session } = recordingSession(events);
    const service = new SubagentsService(makeDeps(session), { cwd: "/p", agentDir: "/.pi" });
    const id = service.spawn({ role: "reviewer", task: "x", maxTurns: 1, parentSessionId: "parent-1" });
    await service.waitForResult(id);
    assert.ok(events.includes("bindExtensions"), "bindExtensions was called");
    assert.ok(events.includes("prompt"), "prompt was called");
    assert.ok(events.indexOf("bindExtensions") < events.indexOf("prompt"), "bindExtensions BEFORE prompt");
  });

  it("bindExtensions called with mode:'print' (non-interactive child)", async () => {
    let captured: any = undefined;
    const listeners: Array<(e: any) => void> = [];
    const session: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: () => {},
      abort: () => {},
      bindExtensions: async (b?: any) => { captured = b; },
      prompt: async () => { listeners.forEach((l) => l({ type: "agent_end" })); },
    };
    const service = new SubagentsService(makeDeps(session), { cwd: "/p", agentDir: "/.pi" });
    const id = service.spawn({ role: "reviewer", task: "x", maxTurns: 1, parentSessionId: "p1" });
    await service.waitForResult(id);
    assert.equal(captured?.mode, "print");
  });

  // C1 同型 bug (子 session 版, 2026-07-01 B2 验证发现):
  // createAgentSession 构造时 ext 工具(web_search/fetch_content/code_search/codegraph_* 等)
  // 未注册, 被 setActiveToolsByName 过滤出活跃集。bindExtensions 后 ext 工具已注册,
  // 但活跃集已固定(不含它们)。makeRoleSessionStartHandler 只 additively 加了
  // report_role_result, 没加 ext 工具。结果 role 配了 ext 工具却调不到:
  // 实测 researcher 报 web_search 'unknown tool', pm 绕道 bash+curl。
  // 修法: bindExtensions 后重新应用完整 tools whitelist(含 ext 工具), 此时 ext 已注册不过滤。
  it("re-applies full tools whitelist after bindExtensions (ext tools like web_search must enter active set)", async () => {
    const setActiveCalls: string[][] = [];
    const listeners: Array<(e: any) => void> = [];
    const session: SubagentSession = {
      subscribe: (l) => { listeners.push(l); return () => {}; },
      setActiveToolsByName: (names) => setActiveCalls.push([...names]),
      abort: () => {},
      bindExtensions: async () => {},
      prompt: async () => { listeners.forEach((l) => l({ type: "agent_end" })); },
    };
    const service = new SubagentsService(makeDeps(session), { cwd: "/p", agentDir: "/.pi" });
    const tools = ["read", "bash", "grep", "find", "ls", "web_search", "fetch_content", "report_role_result"];
    const id = service.spawn({ role: "researcher", task: "x", tools, maxTurns: 1, parentSessionId: "p1" });
    await service.waitForResult(id);
    // bindExtensions 后应有一次 setActiveToolsByName 含完整 tools(含 ext 工具)
    const lastCall = setActiveCalls[setActiveCalls.length - 1];
    assert.ok(lastCall, "setActiveToolsByName called after bindExtensions");
    assert.ok(lastCall.includes("web_search"), "ext tool web_search in re-applied active set");
    assert.ok(lastCall.includes("fetch_content"), "ext tool fetch_content in re-applied active set");
    assert.ok(lastCall.includes("report_role_result"), "report_role_result still in active set");
    assert.ok(lastCall.includes("read"), "built-in tool read still in active set");
  });
});
