import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAGCore, type SpawnFn } from "../src/dag/executor";
import type { DAGSpec } from "../src/dag/types";
import { validateDAG, validateGeneratedSends } from "../src/dag/validate";

const complete = (id: string, findings = [id]) => ({
  agentId: id,
  wait: async () => ({ status: "completed" as const, reportPayload: { findings, artifacts: [] } }),
});

describe("DAG V2 semantic admission", () => {
  it("keeps legacy DAGSpec valid and leaves legacy task text unchanged", async () => {
    const spec: DAGSpec = { nodes: {
      a: { task: "inspect" },
      b: { task: "implement", depends_on: ["a"] },
    } };
    assert.equal(validateDAG(spec).ok, true);
    let rootTask = "";
    await executeDAGCore(spec, async (_role, task) => {
      if (task.startsWith("inspect")) rootTask = task;
      return complete(task);
    });
    assert.equal(rootTask, "inspect");
  });

  it("accepts a complete output/consumer contract and injects it into the child task", async () => {
    const spec: DAGSpec = { nodes: {
      inspect: {
        task: "Inspect the parser boundary",
        expected_output: "A reproducible defect report with the failing input",
        consumers: ["fix"],
      },
      fix: {
        task: "Implement and verify the parser fix",
        depends_on: ["inspect"],
        expected_output: "A tested parser patch",
        consumers: ["$result"],
      },
    } };
    assert.deepEqual(validateDAG(spec).errors, []);
    const tasks: string[] = [];
    const result = await executeDAGCore(spec, async (_role, task) => {
      tasks.push(task);
      return complete(task);
    });
    assert.equal(result.status, "completed");
    assert.match(tasks[0], /Semantic output contract/);
    assert.match(tasks[0], /A reproducible defect report/);
    assert.match(tasks[1], /Consumers: \$result/);
  });

  it("rejects empty, partial, missing, and non-downstream consumer contracts", () => {
    const partial = validateDAG({ nodes: {
      a: { task: "", expected_output: "", consumers: [] },
      b: { task: "consume", depends_on: ["a"], expected_output: "artifact", consumers: ["$result"] },
    } });
    assert.match(partial.errors.join("\n"), /expected_output must be a non-empty string/);
    assert.match(partial.errors.join("\n"), /task must state a non-empty independent problem/);
    assert.match(partial.errors.join("\n"), /consumers must be a non-empty array/);
    assert.match(partial.errors.join("\n"), /omits direct consumer 'b'/);

    const mismatched = validateDAG({ nodes: {
      a: { task: "work", expected_output: "artifact", consumers: ["c"] },
      b: { task: "consume", depends_on: ["a"], expected_output: "review", consumers: ["$result"] },
      c: { task: "unrelated", expected_output: "other", consumers: ["$result"] },
    } });
    assert.match(mismatched.errors.join("\n"), /consumer 'c' must directly depend_on 'a'/);
    assert.match(mismatched.errors.join("\n"), /omits direct consumer 'b'/);
  });

  it("fails semantic admission for a one-node DAG", () => {
    const validation = validateDAG({ nodes: {
      only: { task: "Do one workflow", expected_output: "Completed workflow", consumers: ["$result"] },
    } });
    assert.match(validation.errors.join("\n"), /use direct or specialist execution/);
  });

  it("admits a single declared dispatcher because its generated work is the real DAG", () => {
    const validation = validateDAG({ nodes: {
      fanout: {
        task: "Dispatch independent checks",
        expected_output: "Merged checks",
        consumers: ["$result"],
        dispatch: {},
        sends: [{ key: "one", role: "coder", arg: "check one", expected_output: "One check", consumers: ["$parent"] }],
      },
    } });
    assert.equal(validation.ok, true);
  });

  it("requires the dispatch parent itself to declare an outcome and consumers", () => {
    const validation = validateDAG({ nodes: {
      fanout: {
        task: "Dispatch independent checks",
        dispatch: {},
        sends: [{ key: "one", role: "coder", arg: "check one", expected_output: "One check", consumers: ["$parent"] }],
      },
    } });
    assert.match(validation.errors.join("\n"), /dispatch requires expected_output and consumers/);
  });

  it("rejects only explicit setup/concatenation no-ops and accepts substantive transformations", () => {
    const noOps = validateDAG({ nodes: {
      setup: {
        task: "Set up the context",
        expected_output: "Context ready",
        consumers: ["join"],
      },
      join: {
        task: "Concatenate upstream outputs verbatim",
        depends_on: ["setup"],
        expected_output: "Concatenated output",
        consumers: ["$result"],
      },
    } });
    assert.match(noOps.errors.join("\n"), /setup-only/);
    assert.match(noOps.errors.join("\n"), /only concatenates upstream text/);

    const chineseNoOps = validateDAG({ nodes: {
      setup: { task: "初始化环境", expected_output: "环境已就绪", consumers: ["join"] },
      join: { task: "拼接上游输出即可", depends_on: ["setup"], expected_output: "拼接后的输出", consumers: ["$result"] },
    } });
    assert.match(chineseNoOps.errors.join("\n"), /setup-only/);
    assert.match(chineseNoOps.errors.join("\n"), /only concatenates upstream text/);

    const substantive = validateDAG({ nodes: {
      setup: {
        task: "Prepare a migration environment and create a verified database snapshot",
        expected_output: "Restorable pre-migration snapshot with checksum",
        consumers: ["synthesis"],
      },
      synthesis: {
        task: "Reconcile conflicting findings and decide whether migration is safe",
        depends_on: ["setup"],
        expected_output: "Risk decision with resolved conflicts and rationale",
        consumers: ["$result"],
      },
    } });
    assert.deepEqual(substantive.errors, []);
  });

  it("reports template and same-role merge candidates as advisories, not blockers", () => {
    const forkJoin: DAGSpec = { nodes: {
      root: { role: "researcher", task: "scope" },
      a: { role: "coder", task: "a", depends_on: ["root"] },
      b: { role: "reviewer", task: "b", depends_on: ["root"] },
      join: { role: "chief-reviewer", task: "decide", depends_on: ["a", "b"] },
    } };
    const forkValidation = validateDAG(forkJoin);
    assert.equal(forkValidation.ok, true);
    assert.ok(forkValidation.diagnostics.some((diagnostic) => diagnostic.code === "fork_join_template"));

    const linear = validateDAG({ nodes: {
      a: { role: "coder", task: "first" },
      b: { role: "coder", task: "second", depends_on: ["a"] },
    } });
    assert.equal(linear.ok, true);
    assert.ok(linear.diagnostics.some((diagnostic) => diagnostic.code === "merge_candidate"));
  });
});

describe("generated child semantic contracts", () => {
  it("requires stable unique keys, outputs, and the $parent consumer when opted in", () => {
    const errors = validateGeneratedSends("fanout", [
      { key: "same", role: "coder", arg: "one", expected_output: "patch", consumers: ["$parent"] },
      { key: "same", role: "coder", arg: "two", expected_output: "", consumers: [] },
    ], true);
    assert.match(errors.join("\n"), /duplicate send key 'same'/);
    assert.match(errors.join("\n"), /expected_output must be a non-empty string/);
    assert.match(errors.join("\n"), /consumers must be a non-empty array/);

    const emptyTask = validateGeneratedSends("fanout", [
      { key: "empty", role: "coder", arg: {}, expected_output: "patch", consumers: ["$parent"] },
    ], true);
    assert.match(emptyTask.join("\n"), /arg object must describe a non-empty task/);
  });

  it("validates runtime dynamic children before spawning and propagates the failure downstream", async () => {
    let spawnedChildren = 0;
    let downstreamTask = "";
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch independent checks",
        expected_output: "Merged verified checks",
        consumers: ["final"],
        dispatch: { maxChildren: 4 },
        dynamic: async () => [
          { key: "dup", role: "coder", arg: "one", expected_output: "one result", consumers: ["$parent"] },
          { key: "dup", role: "coder", arg: "two", expected_output: "two result", consumers: ["$parent"] },
        ],
      },
      final: {
        task: "Resolve the check results",
        depends_on: ["fanout"],
        expected_output: "A resolution with failure context",
        consumers: ["$result"],
      },
    } };
    const spawnFn: SpawnFn = async (_role, task) => {
      if (task.startsWith("one") || task.startsWith("two")) spawnedChildren++;
      if (task.startsWith("Resolve")) downstreamTask = task;
      return complete(task);
    };
    const result = await executeDAGCore(spec, spawnFn, { scheduler: "ready" });
    assert.equal(spawnedChildren, 0, "no generated child starts before the complete batch validates");
    assert.equal(result.nodeStates?.fanout.status, "failed");
    assert.match(result.nodeStates?.fanout.error ?? "", /duplicate send key/);
    assert.match(downstreamTask, /Predecessor 'fanout' failed.*duplicate send key/s);
  });

  it("preserves merged fan-out results and downstream context for valid generated contracts", async () => {
    let finalTask = "";
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch independent checks",
        expected_output: "Merged verified checks",
        consumers: ["final"],
        dispatch: { maxChildren: 4 },
        dynamic: async () => [
          { key: "api", role: "coder", arg: "check api", expected_output: "API finding", consumers: ["$parent"] },
          { key: "ui", role: "reviewer", arg: "check ui", expected_output: "UI finding", consumers: ["$parent"] },
        ],
      },
      final: {
        task: "Resolve checks",
        depends_on: ["fanout"],
        expected_output: "Integrated decision",
        consumers: ["$result"],
      },
    } };
    const result = await executeDAGCore(spec, async (_role, task) => {
      if (task.startsWith("Resolve checks")) finalTask = task;
      const finding = task.startsWith("check api") ? "api-ok" : task.startsWith("check ui") ? "ui-ok" : "done";
      return complete(task, [finding]);
    }, { scheduler: "ready" });
    assert.equal(result.status, "completed");
    assert.equal(result.nodeStates?.["fanout::api"].status, "completed");
    assert.equal(result.nodeStates?.["fanout::ui"].status, "completed");
    assert.deepEqual(result.finalContext.fanout.findings, ["api-ok", "ui-ok"]);
    assert.match(finalTask, /api-ok/);
    assert.match(finalTask, /ui-ok/);
  });

  it("rejects an unknown runtime-generated role before spawning the batch", async () => {
    let spawnCount = 0;
    const spec: DAGSpec = { nodes: {
      fanout: {
        task: "Dispatch checks",
        expected_output: "Merged checks",
        consumers: ["final"],
        dispatch: { maxChildren: 4 },
        dynamic: async () => [
          { key: "known", role: "coder", arg: "known", expected_output: "Known check", consumers: ["$parent"] },
          { key: "unknown", role: "missing", arg: "unknown", expected_output: "Unknown check", consumers: ["$parent"] },
        ],
      },
      final: {
        task: "Handle dispatch outcome",
        depends_on: ["fanout"],
        expected_output: "Handled outcome",
        consumers: ["$result"],
      },
    } };
    const result = await executeDAGCore(spec, async () => {
      spawnCount++;
      return complete("child");
    }, { knownRoles: new Set(["coder"]) });
    assert.equal(spawnCount, 1, "only the declared downstream DAG node runs after fan-out validation fails");
    assert.match(result.nodeStates?.fanout.error ?? "", /unknown role 'missing'/);
  });

  it("requires a declared dispatch contract only for semantic fan-out nodes", () => {
    const semantic = validateDAG({ nodes: {
      fanout: {
        task: "fan out",
        expected_output: "merged results",
        consumers: ["final"],
        sends: [{ key: "one", role: "coder", arg: "one", expected_output: "one", consumers: ["$parent"] }],
      },
      final: { task: "decide", depends_on: ["fanout"], expected_output: "decision", consumers: ["$result"] },
    } });
    assert.match(semantic.errors.join("\n"), /must declare a dispatch contract/);

    const legacy = validateDAG({ nodes: {
      fanout: { task: "fan out", sends: [{ role: "coder", arg: "one" }] },
    } });
    assert.equal(legacy.ok, true);
  });
});
