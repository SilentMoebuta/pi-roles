---
name: reviewing-methodology
description: "SOTA code review methodology for AI coding agents: continuous-improvement philosophy (Google), multi-agent verification patterns (Claude Code), 4-tier severity with Pre-existing tier, positive reinforcement, design-first triage, skip rules. Multi-dimensional review covering correctness, security, breaking changes, testing, over-engineering. Use when reviewing code, specs, plans, or any work product."
---

# SOTA Code Review Methodology

## Philosophy

**Favor approving a change once it definitely improves overall code health, even if not perfect.** (Google eng-practices). There is no perfect code — only *better* code through continuous improvement. A reviewer's job is to raise the bar, not demand perfection.

This philosophy shapes every aspect of the review: severity decisions should distinguish "must-fix" from "would-be-nice-to-fix" from "was-already-broken." Evidence requirements ensure precision. The verdict should explicitly state whether the change, as-is, improves overall code health.

## Design-First Triage Process

1. **Broad view first** — does the change even make sense? If it fundamentally doesn't fit, reject immediately with explanation. Don't waste time on fine-grained review.
2. **Main parts next** — examine the core logic, API surface, data flow. If major design problems exist, surface them first.
3. **Rest in sequence** — remaining code reviewed after design is validated.

## Review Dimensions

### Tier 1 — Every Review (mandatory)

| Dimension | Check |
|-----------|-------|
| **Spec/Plan Compliance** | Does the work meet all requirements? Any missing? Any extra (scope creep)? |
| **Correctness** | Edge cases? Null/undefined guarded? Error paths? Concurrency risks? |
| **Security** | Authz/authn? Input validation? Hardcoded secrets? Injection? File traversal? |
| **Breaking Changes** | Public API changed? Backward compat? Migrations needed? |
| **Testing** | Real behavior or mock-only? Edge cases? Regression tests? |
| **Design** | Does the overall design make sense? Right boundaries? Integrates well? Right time to do this? |

### Tier 2 — When Applicable

| Dimension | Check |
|-----------|-------|
| **Architecture** | Clear interfaces? Coupling manageable? |
| **Performance** | N+1 queries? Unbounded loops? Memory leaks? |
| **Code Quality** | Readable? DRY? Consistent naming? Complex functions (>50 lines = review for complexity) |
| **Over-engineering** | Code more generic than needed? Solving speculative future problems? Solve *now*, not *maybe later* |
| **Production Readiness** | Logging? Monitoring? Graceful degradation? Configurable? |
| **Naming** | Clear names — long enough to communicate, not so long they're unreadable |
| **Documentation** | Updated READMEs, docs, comments that explain *why* not *what* |

### Tier 3 — Contextual

| Dimension | Check |
|-----------|-------|
| **YAGNI** | Is any code solving problems that don't exist yet? |
| **File Size** | Did a file grow unreasonably? A 4-line change in a bloated module is still a signal. |
| **Consistency** | Does it follow the project's established patterns? |
| **Every Line** | Review EVERY line. If you can't understand it, that itself is a finding (code is too complex). |

## Severity Levels

| Level | Criteria | Must Fix? |
|-------|----------|-----------|
| **🔴 Critical** | Security holes, data loss, crashes, spec violations, broken public API | Yes — block merge |
| **🟠 Important** | Edge case bugs, missing error handling, perf regression, design issues | Yes — fix before merge |
| **🟡 Minor** | Naming nits, magic numbers, missing comments, style | Optional |
| **🟣 Pre-existing** | Bug already in codebase, NOT introduced by this change | Flag but don't block — file separately |

The 🟣 Pre-existing tier (from Claude Code) prevents the reviewer from being noisy about legacy issues. The change should only be blocked by issues IT introduces. Pre-existing issues are surfaced for awareness, not to gate the change.

## Skip Rules

Do NOT review or report on:
- Generated files (build outputs, lockfiles, compiled assets)
- Vendored/third-party code
- Binary files
- Files matching `.gitignore` patterns
- Pure formatting changes (whitespace-only diffs)

If unsure whether a file is generated/third-party, note it and move on rather than reviewing it.

## Positive Reinforcement

**Always include "Good Things"** alongside issues. (Google practice — code reviews should reinforce good behavior, not just flag problems.) Examples:
- "Well-structured test with clear arrange/act/assert phases"
- "Good edge case coverage — caught the null input path"
- "Clean API design — minimal surface, clear naming"

## Anti-Patterns to Flag

| Anti-Pattern | Description |
|--------------|-------------|
| **Silent failures** | Catching errors without logging or handling |
| **Trusting self-reports** | Accepting "tests pass" without verifying |
| **Missing requirements** | Work that doesn't address the spec/plan |
| **Security gaps** | Missing authz, unsanitized inputs, exposed secrets |
| **Mock-heavy tests** | Tests that only verify mocks, not real integration |
| **Over-engineering** | Code solving future problems that don't exist yet (YAGNI) |
| **Scope creep** | Code beyond what the spec asked for |
| **God functions/files** | Single unit doing too many things (>100 lines) |
| **"Looks good" without evidence** | Vague approval without specific checks |
| **Style-functional mixing** | Style/general changes intermixed with functional changes |

## Evidence Requirements (SOTA)

Every finding MUST cite specific evidence — never infer from naming conventions or "looks like":
- **file:line** citation — exact source location
- **Test output** — actual failure message or command result
- **Counter-example** — concrete scenario where the code fails

"No `file:line`? Not a finding." This is the Claude Code evidence standard — it prevents hallucinations and forces grounding in actual code.

## Output Format

```
## Review: [What was reviewed]

### Verdict
✅ Ready | ⚠️ Ready with fixes | ❌ Not ready
[One sentence: does this improve code health?]

### Good Things
- [Specific, evidence-based praise — required, never skip]

### Spec/Plan Compliance
- [Requirement]: ✅ met / ❌ not met / ⚠️ partially

### Issues
🔴 Critical (N):
- [File:line] — [What] — [Why it matters] — [Fix]

🟠 Important (N):
- ...

🟡 Minor (N):
- ...

🟣 Pre-existing (N):
- ...

### Test Coverage
- Covered: [what's tested]
- Missing: [edge cases, error paths, integration]

### Recommendations
- [Concrete next steps]
```

## Process

1. **Design-first triage** — broad view → main parts → rest
2. **Read the spec/plan/task** — understand what success looks like
3. **Read the diff/files** — every line
4. **Check Tier 1 dimensions** — evidence-based, never assume
5. **Check Tier 2/3** if applicable — apply skip rules
6. **Classify severity** — Critical/Important/Minor/Pre-existing
7. **Identify Good Things** — positive reinforcement
8. **Write verdict** — does this improve code health? State explicitly
9. **Call report_role_result** with findings (one per dimension) and artifacts (files reviewed)
