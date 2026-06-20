---
name: systematic-debugging
description: "SOTA debugging methodology: triage before deep-dive, automate reproduction as test BEFORE fixing, multi-hypothesis generation (2-3 before testing any), root cause statement before fix code, bug classification before strategy selection. Hypothesis-driven: reproduce → triage → hypothesis → verify → root cause → fix → confirm. Use when investigating bugs, unexpected behavior, or regressions."
---

# SOTA Debugging Methodology

## Philosophy

**Don't guess. Don't fix symptoms. Find the root cause, prove it, then apply the minimal fix.** (Zeller's Scientific Method + Google SRE practices). Every fix must trace to a verified root cause through hypothesis-driven investigation.

## 7-Step Debugging Cycle

### Step 0: Triage (NEW — before deep-dive)
Before any investigation, answer:
1. **Known issue?** Check logs, issues, changelogs — has this been reported before?
2. **Environment?** Reproducible on all envs or specific to one? (node version, OS, deps)
3. **Already fixed?** Is there a newer version that resolves it?
4. **Scope?** Is this a regression (worked before) or a new issue?

If triage reveals it's a known/env/already-fixed issue — stop and report. Don't investigate known bugs.

### Step 1: Reproduce the Failure
- Write a MINIMAL reproducing test case
- Run it — confirm it fails with the exact error
- This test becomes your regression guard: if it passes after the fix, the fix worked
- **No repro = no fix.** Never modify code without reproducing first.

### Step 2: Generate Hypotheses (2-3 before testing any)
- Form 2-3 competing hypotheses about the root cause
- For each: what would prove it RIGHT? What would prove it WRONG?
- Rank by likelihood based on the error message, stack trace, and recent changes
- **Rule**: never commit to the first idea. Multi-hypothesis prevents confirmation bias.

### Step 3: Verify the Best Hypothesis
- Add probes: log statements, debug prints, assertions
- Run the reproducing test — does the probe data support or refute the hypothesis?
- If refuted: select the next hypothesis from Step 2
- If all hypotheses refuted: go back to Step 2 with new information

### Step 4: State the Root Cause
Before writing ANY fix code, write a root cause statement:
```
ROOT CAUSE: [What is broken, in [file:line]] 
BECAUSE [Why it's broken — the underlying mechanism]
EVIDENCE: [Probe data, stack trace, test output that proves this]
```
**No root cause statement? No fix code.** This prevents symptom-patching.

### Step 5: Apply the Minimal Fix
- Write the smallest change that addresses the verified root cause
- No "while I'm here" changes — stay focused
- If the fix exposes another issue, file it separately

### Step 6: Confirm the Fix
- Run the reproducing test — it passes
- Run the FULL test suite — no regressions
- If any test breaks: the fix is incomplete or wrong. Revisit Step 2.

## Bug Classification (before choosing strategy)

| Bug Type | Strategy |
|----------|----------|
| **Regression** | Git bisect to find the breaking commit. Hypothesis: what changed? |
| **Crash/Error** | Stack trace + reproduction. Hypothesis: what precondition is violated? |
| **Incorrect output** | Expected vs actual. Hypothesis: where does the computation diverge? |
| **Performance** | Profile + benchmark. Hypothesis: where is the bottleneck? |
| **Race condition** | Add timing probes + stress test. Hypothesis: what ordering is assumed? |
| **Intermittent** | Log frequency + conditions. Hypothesis: what makes it trigger vs not? |

## Anti-Patterns

- **Spray-and-pray** — changing multiple things hoping one works. ONE change per test.
- **Skipping repro** — "I can see the bug in the code" without running it. REPRODUCE FIRST.
- **Single hypothesis** — the first idea is rarely right. Generate 2-3 alternatives.
- **Symptom patches** — fixing the symptom without finding the root cause. ROOT CAUSE FIRST.
- **"While I'm here"** — unrelated changes during a bug fix. File separately.
- **Trusting self-reports** — "tests pass" claimed without actual verification. RUN THEM.
