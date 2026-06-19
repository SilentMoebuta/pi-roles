import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeRoleSkillsOverride, type SkillLike } from "../src/subagent/skills-override";

// skillsOverride: the function passed to DefaultResourceLoader that controls a
// role subagent's skill set. Receives pi's loaded base skills; returns the
// role's resolved set = baseSkills (filtered) ∪ role.domainSkills (loaded).
//
// Phase 2 additive semantics (design doc §5.2): a role with skills:[] inherits
// the full common pool (base unchanged). domainSkills only ADDS. Restrictive
// filtering is a future opt-in, not Phase 2.

interface Skill extends SkillLike {}

function skill(name: string, filePath = "/p/" + name + ".md"): Skill {
  return { name, description: name, filePath, baseDir: "/p", sourceInfo: {} as any, disableModelInvocation: false };
}

describe("makeRoleSkillsOverride (Phase 2 skill isolation)", () => {
  it("role with skills:[] → returns base unchanged (additive: full common pool inherited)", () => {
    const base = [skill("using-superpowers"), skill("tdd"), skill("pi-memory")];
    const override = makeRoleSkillsOverride({ domainSkills: [] });
    const out = override({ skills: base, diagnostics: [] });
    assert.deepEqual(out.skills, base, "base passed through unchanged when no domainSkills");
    assert.equal(out.diagnostics.length, 0);
  });

  it("role with domainSkills (already-loaded Skill[]) → returns base ∪ domainSkills (union, dedup by name)", () => {
    const base = [skill("using-superpowers"), skill("tdd")];
    const domain = [skill("create-prd"), skill("opportunity-solution-tree")];
    const override = makeRoleSkillsOverride({ domainSkills: domain });
    const out = override({ skills: base, diagnostics: [] });
    assert.equal(out.skills.length, 4);
    assert.ok(out.skills.some((s) => s.name === "create-prd"));
    assert.ok(out.skills.some((s) => s.name === "opportunity-solution-tree"));
    assert.ok(out.skills.some((s) => s.name === "using-superpowers"));
  });

  it("dedups: a domainSkill with the same name as a base skill does not duplicate", () => {
    const base = [skill("tdd")];
    const domain = [skill("tdd", "/other/tdd.md")]; // same name, different path
    const override = makeRoleSkillsOverride({ domainSkills: domain });
    const out = override({ skills: base, diagnostics: [] });
    assert.equal(out.skills.length, 1, "no duplicate by name");
    // base wins on conflict (base is the common pool; domain shouldn't shadow it)
    assert.equal(out.skills[0].filePath, "/p/tdd.md");
  });

  it("preserves diagnostics from base (resource-load warnings surface)", () => {
    const diag = { type: "collision", message: "x" } as any;
    const override = makeRoleSkillsOverride({ domainSkills: [] });
    const out = override({ skills: [], diagnostics: [diag] });
    assert.equal(out.diagnostics.length, 1);
    assert.equal(out.diagnostics[0], diag);
  });

  it("empty base + empty domain → empty skills (graceful)", () => {
    const override = makeRoleSkillsOverride({ domainSkills: [] });
    const out = override({ skills: [], diagnostics: [] });
    assert.deepEqual(out.skills, []);
  });

  it("does NOT mutate the input base.skills array (pure)", () => {
    const base = [skill("a")];
    const domain = [skill("b")];
    const override = makeRoleSkillsOverride({ domainSkills: domain });
    override({ skills: base, diagnostics: [] });
    assert.equal(base.length, 1, "base array untouched");
    assert.equal(base[0].name, "a");
  });
});
