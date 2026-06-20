---
name: reviewing-methodology
description: "Structured code review methodology for AI coding agents: multi-dimensional review (spec compliance, correctness, security, testing), severity classification (Critical/Important/Minor), mandatory evidence per finding, structured output format. Use when reviewing code, specs, plans, or any work product."
---

# Code Review Methodology

## Purpose

Systematic code review that catches real defects — not rubber-stamping. Every finding must cite specific evidence (file:line, test output, counter-example). Every verdict must be grounded in the review dimensions below.

## Review Dimensions

### Tier 1 — Every Review (mandatory)

| Dimension | Check |
|-----------|-------|
| **Spec/Plan Compliance** | Does the work meet all requirements? Any missing? Any extra (scope creep)? |
| **Correctness** | Edge cases handled? Null/undefined guarded? Error paths? Race conditions? |
| **Security** | Authz/authn? Input validation? Hardcoded secrets? Injection risks? File traversal? |
| **Breaking Changes** | Public API changed? Backward compat? Migrations needed? |
| **Testing** | Real behavior or mock-only? Edge cases covered? Regression tests? |

### Tier 2 — When Applicable

| Dimension | Check |
|-----------|-------|
| **Architecture** | Right boundaries? Clear interfaces? Coupling manageable? |
| **Performance** | N+1 queries? Unbounded loops? Memory leaks? Excessive allocations? |
| **Code Quality** | Readable? DRY? Consistent naming? Complex functions (>50 lines)? |
| **Production Readiness** | Logging? Monitoring? Graceful degradation? Configurable? |

### Tier 3 — Contextual

| Dimension | Check |
|-----------|-------|
| **YAGNI** | Is any code solving problems that don't exist yet? |
| **File Size** | Did a file grow unreasonably? (signal for boundary re-examination) |
| **Consistency** | Does it follow the project's established patterns? |

## Severity Levels

| Level | Criteria | Must Fix? |
|-------|----------|-----------|
| **🔴 Critical** | Security holes, data loss, crashes, spec violations, broken public API | Yes — block merge |
| **🟠 Important** | Edge case bugs, missing error handling, perf regression, excessive test mocking | Yes — fix before merge |
| **🟡 Minor** | Naming nits, magic numbers, missing comments, minor style | Optional — note and move on |

## Anti-Patterns to Flag

- **Silent failures** — catching errors without logging or handling
- **Trusting self-reports** — accepting "tests pass" without verifying
- **Missing requirements** — work that doesn't address the spec/plan
- **Security gaps** — missing authz checks, unsanitized inputs, exposed secrets
- **Mock-heavy tests** — tests that only verify mock behavior, not real integration
- **Scope creep** — code that goes beyond what the spec asked for
- **God functions/files** — single unit doing too many things (>100 lines)
- **"Looks good" without evidence** — vague approval without specific checking

## Output Format

```
## Review: [What was reviewed]

### Verdict
✅ Ready | ⚠️ Ready with fixes | ❌ Not ready

### Strengths
- [Specific, evidence-based praise]

### Spec/Plan Compliance
- [Requirement]: ✅ met / ❌ not met / ⚠️ partially

### Issues
🔴 Critical (N):
- [File:line] — [What] — [Why it matters] — [Fix suggestion]

🟠 Important (N):
- ...

🟡 Minor (N):
- ...

### Test Coverage
- Covered: [what's tested]
- Missing: [edge cases, error paths, integration scenarios]

### Recommendations
- [Concrete, actionable next steps]
```

## Process

1. **Read the spec/plan/task** first — understand what success looks like
2. **Read the diff/files** — identify what changed
3. **Check each Tier 1 dimension** — mandatory, evidence-based
4. **Check Tier 2 dimensions** if applicable
5. **Classify severity** — Critical vs Important vs Minor
6. **Write verdict with evidence** — no "looks good" without specific checks
7. **Call report_role_result** with findings (one per dimension) and artifacts (files reviewed)
