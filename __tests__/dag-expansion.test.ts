import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandDispatchNode, generatedChildren, generatedNodeId } from "../src/dag/expansion";
import { validateDAG } from "../src/dag/validate";
import type { DAGSpec } from "../src/dag/types";

describe("dispatch expansion", () => {
  it("uses stable keys and rewrites producer/child/join consumer edges", () => {
    const spec: DAGSpec = { nodes: {
      source: {
        task: "collect",
        expected_output: "collected input",
        consumers: ["fanout"],
      },
      fanout: {
        task: "dispatch",
        depends_on: ["source"],
        expected_output: "merged checks",
        consumers: ["final"],
        dispatch: { maxChildren: 4 },
        sends: [
          { key: "api", role: "coder", arg: "check api", expected_output: "api result", consumers: ["$parent"] },
          { key: "ui", role: "reviewer", arg: "check ui", expected_output: "ui result", consumers: ["$parent"] },
        ],
      },
      final: {
        task: "decide",
        depends_on: ["fanout"],
        expected_output: "decision",
        consumers: ["$result"],
      },
    } };
    const expanded = expandDispatchNode(spec, "fanout", spec.nodes.fanout.sends!);
    assert.equal(generatedNodeId("fanout", "api"), "fanout::api");
    assert.deepEqual(generatedChildren(expanded.generatedNodes, "fanout"), ["fanout::api", "fanout::ui"]);
    assert.deepEqual(expanded.spec.nodes.source.consumers, ["fanout", "fanout::api", "fanout::ui"]);
    assert.deepEqual(expanded.spec.nodes["fanout::api"].depends_on, ["source"]);
    assert.deepEqual(expanded.spec.nodes["fanout::api"].consumers, ["fanout"]);
    assert.deepEqual(expanded.spec.nodes.fanout.depends_on, ["source", "fanout::api", "fanout::ui"]);
    assert.equal(expanded.spec.nodes.fanout.sends, undefined);
    assert.deepEqual(validateDAG(expanded.spec).errors, []);
  });

  it("rejects generated ids that collide with declared nodes", () => {
    const spec: DAGSpec = { nodes: {
      fanout: { task: "dispatch", dispatch: {}, sends: [{ key: "api", role: "coder", arg: "check" }] },
      "fanout::api": { task: "declared" },
    } };
    assert.throws(() => expandDispatchNode(spec, "fanout", spec.nodes.fanout.sends!), /collides/);
  });
});
