import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileWorkflowToDAG, executeBoundedWorkflowLoop, validateWorkflowContract, type WorkflowContractV1 } from "../src/dag/workflow-contract";

const task = (id: string) => ({ id, task: `run ${id}` });

describe("workflow contract V1", () => {
  it("compiles direct, sequential, parallel, handoff, and explicit DAG workflows", () => {
    const sequential: WorkflowContractV1 = { schemaVersion: 1, id: "seq", kind: "sequential", tasks: [task("a"), task("b"), { ...task("c"), dependsOn: ["a"] }] };
    assert.deepEqual(compileWorkflowToDAG(sequential).nodes.b.depends_on, ["a"]);
    assert.deepEqual(new Set(compileWorkflowToDAG(sequential).nodes.c.depends_on), new Set(["a", "b"]));
    assert.equal(validateWorkflowContract({ schemaVersion: 1, id: "direct", kind: "direct", tasks: [task("one")] }).ok, true);
    assert.equal(validateWorkflowContract({ schemaVersion: 1, id: "parallel", kind: "parallel", tasks: [task("a"), task("b")] }).ok, true);
    assert.equal(validateWorkflowContract({ schemaVersion: 1, id: "handoff", kind: "handoff", tasks: [task("a"), task("b")] }).ok, true);
    assert.equal(validateWorkflowContract({ schemaVersion: 1, id: "dag", kind: "dag", tasks: [task("a"), { ...task("b"), dependsOn: ["a"] }] }).ok, true);
  });

  it("compiles conditional routing and map/reduce into DAG nodes", () => {
    const conditional: WorkflowContractV1 = {
      schemaVersion: 1, id: "choice", kind: "conditional",
      tasks: [task("route"), task("accept"), task("revise")],
      condition: { routerId: "route", routes: { accept: ["accept"], revise: ["revise"] } },
    };
    const choice = compileWorkflowToDAG(conditional);
    assert.deepEqual(choice.nodes.route.routes, { accept: ["accept"], revise: ["revise"] });
    assert.deepEqual(choice.nodes.accept.depends_on, ["route"]);

    const mapReduce: WorkflowContractV1 = {
      schemaVersion: 1, id: "mr", kind: "map_reduce", tasks: [task("reduce")],
      mapReduce: { items: [{ key: "one", input: "A" }, { key: "two", input: "B" }], mapTask: "map {{key}}={{input}}", reduceTaskId: "reduce" },
    };
    const compiled = compileWorkflowToDAG(mapReduce);
    assert.equal(compiled.nodes["map:one"].task, "map one=A");
    assert.deepEqual(new Set(compiled.nodes.reduce.depends_on), new Set(["map:one", "map:two"]));
  });

  it("rejects semantic contradictions and dependency cycles before execution", () => {
    const parallel = validateWorkflowContract({ schemaVersion: 1, id: "bad-parallel", kind: "parallel", tasks: [task("a"), { ...task("b"), dependsOn: ["a"] }] });
    assert.equal(parallel.ok, false);
    if (!parallel.ok) assert.match(parallel.errors.join(" "), /parallel task/);
    const cyclic = validateWorkflowContract({ schemaVersion: 1, id: "cycle", kind: "dag", tasks: [{ ...task("a"), dependsOn: ["b"] }, { ...task("b"), dependsOn: ["a"] }] });
    assert.equal(cyclic.ok, false);
    if (!cyclic.ok) assert.match(cyclic.errors.join(" "), /dependency cycle/);
    const invalidMap = validateWorkflowContract({
      schemaVersion: 1, id: "bad-map", kind: "map_reduce", tasks: [task("reduce")],
      mapReduce: { items: [{ key: "../unsafe", input: "x" }], mapTask: "map", reduceTaskId: "reduce" },
    });
    assert.equal(invalidMap.ok, false);
		assert.doesNotThrow(() => validateWorkflowContract({ schemaVersion: 1, id: "bad-json", kind: "conditional", tasks: [{ id: "router", task: "route" }], condition: { routerId: "router", routes: null } } as any));
		assert.equal(validateWorkflowContract({ schemaVersion: 1, id: "bad-json", kind: "map_reduce", tasks: [{ id: "reduce", task: "reduce" }], mapReduce: { items: null, mapTask: "map", reduceTaskId: "reduce" } } as any).ok, false);
  });

  it("executes a loop only up to its declared bound", async () => {
    const loop: WorkflowContractV1 = { schemaVersion: 1, id: "loop", kind: "loop", tasks: [task("refine")], loop: { maxIterations: 3, until: "verified" } };
    const completed = await executeBoundedWorkflowLoop<number>(loop, async ({ iteration, previous }) => ({ value: (previous ?? 0) + 1, done: iteration === 2 }));
    assert.equal(completed.status, "completed");
    assert.equal(completed.iterations.length, 2);
    const limited = await executeBoundedWorkflowLoop<number>(loop, async ({ iteration }) => ({ value: iteration, done: false }));
    assert.equal(limited.status, "limit_reached");
    assert.equal(limited.iterations.length, 3);
  });
});
