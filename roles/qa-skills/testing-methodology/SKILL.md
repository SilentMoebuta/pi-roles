---
name: testing-methodology
description: "QA testing methodology for AI coding agents: behavior-not-implementation testing, edge case enumeration, test surface discovery, failure triage (real bug/test bug/flaky), coverage gap analysis. Use when designing test strategy, authoring test suites, or verifying behavior correctness."
---

# Testing Methodology

## Purpose

Author tests that **verify behavior correctness** — proactive test design, not reactive review. Tests survive refactors because they assert *what* not *how*.

## Workflow

### Phase 1: Identify Test Surfaces
Read code (codegraph_callers/callees), find entry points + behaviors to verify. What's the public contract?

### Phase 2: Enumerate Test Cases
Happy path → boundary → error → concurrency → property-based ("for all valid inputs X, property P holds"). One-line each, ordered by value.

### Phase 3: Author Tests (RED first for new behavior)
Write tests that fail for the right reason. TDD-style: failing test → hand to coder for implementation.

### Phase 4: Run + Triage Failures
Execute, categorize each failure:
- **real bug** — report to dispatcher for debugger (with the failing test)
- **test bug** — fix the test
- **flaky** — investigate (often real concurrency/timing issue)

### Phase 5: Coverage Check
Identify untested paths (codegraph), add tests for gaps. Coverage is a lower bound, not a goal.

### Phase 6: Output Test Report
Coverage + failures categorized + recommendations.

## Anti-Patterns

- Tests asserting implementation details (break on refactor)
- Weakening assertions to make tests pass (failure is information)
- Skipping edge cases "to save time"
- Property-based tests without shrinking
- Mock-heavy tests that test mocks not behavior

## Boundary

qa = proactive test authoring + verification. reviewer = reactive review of existing changes. debugger = fix bugs qa finds. coder = TDD during implementation.
