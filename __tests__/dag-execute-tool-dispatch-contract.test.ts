import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDagExecuteTool } from "../src/dag/dag-execute-tool";
import type { RoleDef } from "../src/roles";

function role(name: string): RoleDef {
  return {
    name,
    description: name,
    prompt: `act as ${name}`,
    tools: ["read"],
    maxTurns: 5,
    canSpawn: false,
    teammates: [],
    skills: [],
  };
}

describe("dag_execute result dispatch contract", () => {
  it("exposes nested sends to the dispatcher and executes its returned work", async () => {
    const spawns: Array<{ id: string; role?: string; task: string; customTools?: any[] }> = [];
    const service = {
      spawn: (params: any) => {
        const id = `agent-${spawns.length}`;
        spawns.push({ id, role: params.role, task: params.task, customTools: params.customTools });
        return id;
      },
      waitForResult: async (id: string) => {
        const spawn = spawns.find((entry) => entry.id === id)!;
        const reportPayload = spawn.role === "planner"
          ? {
              findings: ["planned"],
              artifacts: [],
              sends: [{ key: "api", role: "coder", arg: "check api", expected_output: "API result", consumers: ["$parent"] }],
            }
          : { findings: ["api-ok"], artifacts: [] };
        return { id, status: "completed", result: "ok", turnCount: 1, reportPayload };
      },
      abort: () => true,
    } as any;
    const tool = makeDagExecuteTool({
      roleRegistry: new Map([["planner", role("planner")], ["coder", role("coder")]]),
      service,
      reportState: { reported: new Set(), activeRole: new Map(), payloads: new Map() },
      cwd: "/tmp",
      agentDir: "/tmp",
    });

    const response = await tool.execute("dispatch", { spec: { nodes: {
      fanout: {
        role: "planner",
        task: "choose checks",
        expected_output: "Merged checks",
        consumers: ["$result"],
        dispatch: { maxChildren: 3 },
      },
    } } }, undefined, undefined, {} as any);

    assert.equal((response.details as any).status, "completed");
    assert.deepEqual(spawns.map((spawn) => spawn.role), ["planner", "coder"]);
    const dispatcher = spawns[0];
    assert.match(dispatcher.task, /\[result dispatch contract\]/);
    assert.match(dispatcher.task, /at most 3 items/);
    const schema = dispatcher.customTools?.[0]?.parameters;
    assert.ok(schema.required.includes("sends"));
    assert.equal(schema.properties.sends.type, "array");
    assert.equal(schema.properties.sends.maxItems, 3);
    assert.equal(schema.properties.sends.items.type, "object");
    assert.deepEqual(
      [...schema.properties.sends.items.required].sort(),
      ["arg", "consumers", "expected_output", "key", "role"],
    );
  });
});
