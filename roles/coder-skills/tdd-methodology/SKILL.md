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

## Test List First (TLTCRC)

Before writing any test, write a TEST LIST: enumerate every behavior + edge case the code must handle (happy path, boundary, error, null/empty, concurrent if relevant). This catches forgotten edge cases BEFORE implementation biases you. The list is a checklist — check each off as you RED→GREEN it.

## Detroit over London (for AI-agent TDD)

Prefer Detroit-school (state/behavior, fewer mocks) over London-school (interaction-heavy mocking). AI agents over-mock → tests pass with mocks but fail with real objects. Mock only at trust boundaries (external APIs, the clock, the filesystem when slow); use the real thing for in-repo code.

## Property-Based Testing (fast-check)

For logic with invariants (parsers, serializers, state machines, math), add property-based tests (QuickCheck/Hypothesis; `fast-check` is the drop-in for TS). Instead of 3 examples, assert the INVARIANT holds for 1000 generated inputs:

```ts
import fc from "fast-check";
fc.assert(fc.property(fc.array(fc.integer()), (arr) => {
  const roundtrip = deserialize(serialize(arr));
  assert.deepEqual(roundtrip, arr); // invariant: serialize→deserialize is identity
}));
```

Catches edge cases example-tests miss (empty, negatives, large, duplicates). Highest-leverage testing gap for the coder role.

## Mutation Testing (Stryker) — Test-Quality Gate

To verify your tests actually catch bugs (not just cover lines), run Stryker (active JS/TS mutator in 2026). It mutates your code (flips `> ` to `>=`, removes conditions) and checks if a test fails. Surviving mutants = tests that don't catch the bug. Gate behind a role flag (suite×N mutants is heavy) — run before merging high-risk logic.

## Atomic Commits with WHY Body

Commit after each GREEN step, with a body explaining WHY (not just what). `git commit -m "fix(auth): guard null user" -m "Guards against the race where the session is created before the user record lands. Closes the null-deref seen in prod log X."` The WHY is the audit trail; the what is in the diff.
