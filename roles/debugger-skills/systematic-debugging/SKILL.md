---
name: systematic-debugging
description: "Hypothesis-driven debugging: reproduce → hypothesis → verify → fix → confirm. Never guess-patch. Every fix must trace to a verified root cause. Use when investigating bugs, unexpected behavior, or regressions."
---

# Systematic Debugging

## Purpose

Fix bugs by understanding them first. Hypothesis-driven cycle prevents random fixes and regressions.

## 5-Step Cycle

### Step 1: Reproduce the Failure
- Run the exact command or test that fails
- Capture the full error output and stack trace
- No repro = no understanding. Don't skip this.

### Step 2: Form a Hypothesis
- Read the relevant code (grep/find/read)
- Trace the error backward from the failure point
- Form ONE specific hypothesis about the root cause

### Step 3: Verify the Hypothesis
- Add a probe: a log statement, a debug print, or a minimal test
- Run it — does the probe confirm your hypothesis?
- If disproved: go back to Step 2 with the new information

### Step 4: Apply the Minimal Fix
- Write the smallest change that fixes the verified cause
- No "while I'm here" changes — stay focused on the bug

### Step 5: Confirm the Fix
- Rerun the original repro — it passes
- Run adjacent tests — no regressions introduced
- If any test breaks: revisit Step 2

## Anti-Patterns

- Spray-and-pray: changing multiple things hoping one works
- Skipping repro: "I can see the bug in the code" without running it
- Fixing symptoms instead of root causes
- "While I'm here" refactoring that introduces new bugs
