// makeRoleSkillsOverride — builds the `skillsOverride` function passed to
// DefaultResourceLoader for a role subagent's session.
//
// Phase 2 additive semantics (design doc §5.2): a role inherits the full common
// pool (base skills pi loaded) UNCHANGED when its `skills:` frontmatter is empty.
// domainSkills only ADDS to the pool. Restrictive filtering (removing base skills
// a role shouldn't see) is a future opt-in, not Phase 2 — the current installed
// skills are all role-general engineering methodology, none are role-exclusive.
//
// `base.skills` (passed in by pi) is the resolved main-agent skill pool, solving
// the baseSkills acquisition problem that blocked the file-bridge approach
// (ExtensionContext exposes no skill-read API, but skillsOverride receives the
// loaded skills directly).

import type { Skill } from "@earendil-works/pi-coding-agent";

// SkillLike removed — now using pi's exported Skill type.

export interface SkillsOverrideInput {
  skills: Skill[];
  diagnostics: unknown[];
}

export interface SkillsOverrideOutput {
  skills: Skill[];
  diagnostics: unknown[];
}

export interface RoleSkillsOverrideOptions {
  /** Already-loaded domain skills (Skill[]) for this role. Phase 1 roles pass []. */
  domainSkills: Skill[];
}

export function makeRoleSkillsOverride(opts: RoleSkillsOverrideOptions) {
  return function (base: SkillsOverrideInput): SkillsOverrideOutput {
    // Dedup by name: base wins on conflict (common pool shouldn't be shadowed by
    // a domain skill of the same name). Phase 2 is additive — base passes through.
    const baseNames = new Set(base.skills.map((s) => s.name));
    const added = opts.domainSkills.filter((s) => !baseNames.has(s.name));
    return {
      skills: [...base.skills, ...added],
      diagnostics: base.diagnostics,
    };
  };
}
