---
name: tdd-methodology
description: "Test-Driven Development methodology: write a failing test first, implement the minimum code to pass, then refactor. Red-Green-Refactor cycle. Use when writing code, tests, or implementing features."
---

# TDD Methodology

## Purpose

Write correct code faster by testing first. Every line of implementation code must be driven by a failing test.

## Red-Green-Refactor Cycle

1. **RED** — Write a minimal failing test that captures the desired behavior
2. **GREEN** — Write the minimum code to make the test pass (no more, no less)
3. **REFACTOR** — Clean up while tests stay green (remove duplication, improve names)

## Rules

- NEVER write implementation code without a failing test first
- Each test should test ONE thing
- Keep diffs minimal — only the code needed for the current test
- Commit after each green step (frequent, small commits)
- If a test is hard to write, the design may be wrong

## Anti-Patterns

- Writing all tests then all code (waterfall TDD)
- Skipping the REFACTOR step
- Tests that test mocks instead of real behavior
- Over-engineering: writing code for future requirements
