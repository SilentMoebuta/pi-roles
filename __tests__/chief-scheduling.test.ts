import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeDAG, type SpawnFn, type SpawnHandle } from "../src/dag/executor";

describe("chief-reviewer scheduling with 5-node DAG", () => {
  it("chief-reviewer depends_on 4 wave0 nodes → 2 waves, chief in wave1", async () => {
    const spec: any = {
      nodes: {
        'legal-counsel':                {role:'legal-counsel',task:'审法务'},
        'financial-analyst':            {role:'financial-analyst',task:'审财务'},
        'business-expert':              {role:'business-expert',task:'审业务'},
        'competition-compliance-expert':{roleDef:{name:'comp',description:'d',prompt:'p',tools:['read'],maxTurns:30},task:'审合规'},
        'chief-reviewer':               {role:'chief-reviewer',task:'汇总',depends_on:['legal-counsel','financial-analyst','business-expert','competition-compliance-expert']},
      }
    };
    const mkSpawn = () => (async (role: any, task: any, roleDef?: any, model?: any, thinkingLevel?: any) => ({
      agentId: role ?? 'default',
      async wait() { return { status: 'completed' as const, result: { findings: [], artifacts: [] } }; }
    }) as SpawnHandle) as SpawnFn;
    const r = await executeDAG(spec, mkSpawn());
    assert.equal(r.waves.length, 2, "should have 2 waves");
    assert.equal(r.waves[0].successes.length, 4, "wave0: 4 nodes");
    assert.equal(r.waves[1].successes.length, 1, "wave1: chief-reviewer");
    assert.equal(r.waves[1].successes[0].nodeId, "chief-reviewer");
    assert.ok(r.finalContext["chief-reviewer"], "chief in finalContext");
    assert.ok(r.finalContext["legal-counsel"]);
  });
});
