---
name: tdd-methodology
description: "SOTA TDD methodology for AI coding agents: structured test list before coding, Detroit TDD (real behavior not mocks), atomic commits after each GREEN with conventional format, full test suite after each change, edge case enumeration, continuous improvement posture. Use when writing code, tests, or implementing features."
---

# SOTA TDD Methodology

## Philosophy

**Favor approving a change once it definitely improves overall code health, even if not perfect.** (Google eng-practices). Aim for strict improvement, not perfection. Commit early, commit small.

## Structured TDD Cycle

### Phase 0: Test List (NEW — before any code)
Before touching implementation:
1. Enumerate ALL edge cases: null/empty inputs, boundary values, error paths, concurrent access
2. Write each case as a one-line test description
3. Order by: happy path → edge cases → error paths → integration

### Phase 1: RED
- Write ONE failing test that captures the next test case from the list
- Document the expected failure (so you know it's intentional)
- Run ONLY this test → confirm it fails with the expected message

### Phase 2: GREEN
- Write the MINIMUM code to pass the test — no more, no less
- Run the FULL test suite (not just the new test) → all pass
- Commit atomically: `git commit -m "type(scope): description"`

### Phase 3: REFACTOR
- Clean up: remove duplication, improve names, simplify logic
- Run the full test suite → all still pass
- Check: did this refactor enable simplifications in adjacent code?
- Commit: `git commit -m "refactor(scope): description"`

## Commit Discipline

| When | Format | Example |
|------|--------|---------|
| After each GREEN | `feat(scope): description` | `feat(auth): add rate limiting to login endpoint` |
| After each REFACTOR | `refactor(scope): description` | `refactor(auth): extract token validation helper` |
| After each FIX | `fix(scope): description` | `fix(auth): handle null token in middleware` |
| After test-only addition | `test(scope): description` | `test(auth): add edge case for expired tokens` |

## Testing Standards

1. **Detroit TDD** — test real behavior, not mocks. Use real objects unless external service.
2. **Test ONE thing per test** — clear arrange/act/assert phases.
3. **Full suite after every GREEN** — `npm test` after every code change. No exceptions.
4. **Edge cases explicit** — list in test descriptions: "returns 401 for null token", "returns 400 for empty body"
5. **Regression guard** — if a bug is found, add a test that reproduces it BEFORE fixing.

## Continuous Improvement Checklist

Before calling report_role_result:
- [ ] All tests pass (full suite, not just new ones)
- [ ] Edge cases enumerated and tested
- [ ] No over-engineering (code for NOW, not maybe-later)
- [ ] Names clear — long enough to communicate
- [ ] Comments explain WHY not WHAT (if needed)
- [ ] Follows existing project patterns
- [ ] All commits are atomic with conventional format

## Anti-Patterns

- **Waterfall TDD** — writing all tests then all code. Strict RED→GREEN→REFACTOR per test.
- **Skip refactor** — code that works but is ugly stays ugly. REFACTOR is mandatory.
- **Mock-everything tests** — tests that pass with mocks but fail with real objects.
- **Over-engineering** — solving future problems. YAGNI: You Ain't Gonna Need It.
- **"Tests pass" without verification** — actually run them and check output.
- **Big-bang commits** — 10 files in one commit. Commit after each GREEN step.
