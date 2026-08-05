import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  appendSpawnProvenance,
  SPAWN_PROVENANCE_TYPE,
} from "../src/subagent/provenance";

describe("spawned-session provenance", () => {
  it("persists stable agent, role, session, and parent identity", () => {
    const entries: Array<{ customType: string; data: unknown }> = [];
    const written = appendSpawnProvenance({
      appendCustomEntry: (customType, data) => { entries.push({ customType, data }); },
    }, {
      agentId: "sub_100_0",
      role: "reviewer",
      sessionId: "child-session",
      parentSession: "/tmp/main.jsonl",
    });

    assert.equal(written, true);
    assert.deepEqual(entries, [{
      customType: SPAWN_PROVENANCE_TYPE,
      data: {
        schemaVersion: 1,
        agentId: "sub_100_0",
        role: "reviewer",
        sessionId: "child-session",
        parentSession: "/tmp/main.jsonl",
      },
    }]);
  });

  it("reports an unsupported session manager without inventing provenance", () => {
    assert.equal(appendSpawnProvenance({}, {
      agentId: "sub_100_0",
      role: "reviewer",
      sessionId: "child-session",
      parentSession: null,
    }), false);
  });
});
