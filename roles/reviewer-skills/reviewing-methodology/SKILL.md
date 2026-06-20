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

## Security Review — OWASP Top 10:2025 Checklist

When the change touches auth, input handling, config, deps, or data flows, enumerate the OWASP Top 10:2025 (the current version — verified against owasp.org/Top10; 2021 is superseded) as concrete checks:

- **A01:2025 Broken Access Control** — are authz checks present on every protected route? IDOR? privilege escalation via the diff?
- **A02:2025 Security Misconfiguration** — defaults safe? debug/error output scrubbed? headers/CORS/secrets-in-config?
- **A03:2025 Software Supply Chain Failures** — new deps? lockfile/provenance? known CVEs? typosquatting?
- **A04:2025 (see OWASP for the 2025 name)** — verify against the 2025 list before hardcoding
- **A05:2025 Injection** — parameterized queries? shell escaping? template injection?
- **A06:2025 (verify 2025 name)** — crypto misuse? weak algorithms? hardcoded keys?
- **A07:2025 (verify 2025 name)** — auth/session weaknesses
- **A08:2025 Software or Data Integrity Failures** — unsigned updates? deserialization of untrusted data?
- **A09:2025 Security Logging & Alerting Failures** — are security events logged? log injection?
- **A10:2025 Mishandling of Exceptional Conditions** — does the diff fail-open on error? leak via exceptions?

NOTE: verify the exact A04-A07 2025 category names against owasp.org/Top10/2025 before asserting them (the list shifted; the 2025 release is the current version, superseding 2021).

## Conventional Comments

Label every finding with a Conventional Comments prefix so downstream filtering + severity triage is machine-readable:

- `praise:` — positive (balances criticism; call out good things)
- `nitpick:` — trivial, blocking=no
- `suggestion:` — improvement, not required
- `issue:` — real problem, blocking depends on severity
- `question:` — clarify intent
- `thought:` — open idea, no action required
- `todo:` — follow-up, not blocking this change
- `chore:` — hygiene (deps, cleanup)

Pair each with blocking/non-blocking: e.g. `issue(blocking): ...`, `nitpick(non-blocking): ...`.

## Supply-Chain Review (elevated 2025-2026)

Supply-chain security is STRONGLY more relevant in 2025-2026 (SLSA framework, npm provenance now default, multiple high-profile incidents). When deps change:
- Lockfile integrity + provenance verification
- License compatibility
- Known-vuln scan (npm audit / osv-scanner)
- Typosquatting / dependency-confusion checks on new package names

## Verification/Refutation Pass (newer SOTA pattern)

Before posting HIGH-severity findings, do a refutation pass: try to PROVE the finding is a false positive (would the test actually fail? is the input reachable?). This directly cuts LLM-review false positives (the #1 AI reviewer failure mode). Drop any finding you can't substantiate with a concrete reproduction.

## Cross-Role Handoff Protocol + Confidence Calibration

**Handoff:** your `report_role_result` findings are consumed by a DOWNSTREAM role that has NOT seen your context. Structure findings for the CONSUMER, not yourself:
- Lead with what the consumer needs to act on (not your process)
- Include file:line refs + concrete reproduction, not summaries of summaries
- Tag blocking vs non-blocking so the consumer can triage

**Confidence calibration:** state High/Med/Low confidence on each finding, grounded in evidence strength (High = reproduced + verified; Med = strong inference; Low = hypothesis). Extends to all roles: researcher (citation density), planner (ADR certainty), coder (edge-case coverage), debugger (verification rigor). Don't claim High without proof.
