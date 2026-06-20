---
name: role-orchestration
description: "Orchestrate the 5 SOTA pi-roles into a pipeline for autonomous research and development work. Guides the main agent on when to spawn each role, how to chain them (researcher→planner→reviewer→coder→debugger→reviewer), and how to pass context between them. Use when executing multi-step autonomous tasks that involve research, planning, implementation, and review."
---

# Role Orchestration Pipeline

## Purpose

Orchestrate the 5 SOTA pi-roles into an autonomous pipeline: research → plan → review → implement → debug → review. Each role handles one phase. The main agent orchestrates — passing context between roles, deciding when to proceed, handling failures.

## The 5-Role Pipeline

```
researcher ──→ planner ──→ reviewer ──→ coder ──→ debugger ──→ reviewer
 "find out"    "how to"    "is it right?"  "build it"  "why broken?"  "is it fixed?"
```

## When to Use Which Role

| User says / task requires | First spawn | Then |
|---|---|---|
| "Research X", "Find out Y", "Compare A vs B" | researcher | planner (if implementation follows) |
| "Plan X", "Design Y", "Architecture for Z" | researcher → planner | reviewer → coder |
| "Build X", "Implement Y" | planner (if existing plan) → reviewer → coder | debugger (if fails) |
| "Fix bug X", "Debug Y" | debugger | reviewer |
| "Review this code/plan" | reviewer | coder (if fixes needed) |
| Autonomous goal with open-ended task | researcher → planner → reviewer → coder → debugger → reviewer |

## Pipeline Stages

### Stage 1: Research (researcher)
```
spawn_role({role:'researcher', task:'Research [topic]. Find 2+ independent sources. Assign confidence. Report findings.'})
```
- Wait for result. If confidence LOW → spawn researcher AGAIN with refined task.
- Extract key findings from result. These become context for planner.

### Stage 2: Plan (planner)
```
spawn_role({role:'planner', task:'Plan [feature]. Research findings: [summary from Stage 1]. Produce tasks with role/deps/wave.'})
```
- Wait for result. Plan must have tasks with role assignments, dependency tags, and wave groupings.
- If plan is vague or missing wave structure → ask planner to revise.

### Stage 3: Plan Review (reviewer)
```
spawn_role({role:'reviewer', task:'Review this plan: [plan summary]. Check: spec compliance, feasibility, missing steps, risky assumptions. Good Things required.'})
```
- If ⚠️ or ❌ → return plan to planner with reviewer's feedback.
- If ✅ → proceed to implementation.

### Stage 4: Implement (coder, parallel waves)
```
For Wave 0 tasks (deps: []):
  spawn_role({role:'coder', task:'[task description from plan]. Follow TDD: test list first, one RED, one GREEN, full suite, conventional commit.'})
  (all Wave 0 tasks in parallel)

Wait for all Wave 0 → For Wave 1 (deps: [Wave 0 task IDs]):
  spawn_role({role:'coder', task:'[task description]. Context: [relevant Wave 0 outputs]. TDD as above.'})
  ...
```
- Each coder task is ONE atomic step from the plan.
- If any coder fails → spawn debugger (Stage 5), then retry.
- After all waves complete → Stage 6.

### Stage 5: Debug (debugger, if failure)
```
spawn_role({role:'debugger', task:'Fix bug: [error description from failed coder]. Follow 7-step: triage, repro, hypothesize, verify, root cause, fix, confirm.'})
```
- Wait for fix. Then retry the failed coder from Stage 4.
- If debugger can't fix → escalate to user (ask_user).

### Stage 6: Final Review (reviewer)
```
spawn_role({role:'reviewer', task:'Review final implementation. Check: all plan tasks done? tests pass? no regressions? Good Things required. 🟣 Pre-existing for legacy issues.'})
```
- If ✅ → task complete.
- If ⚠️ → spawn coder for remaining fixes.
- If ❌ → escalate to user.

## Context Passing

When chaining roles, ALWAYS pass the previous role's output as context:

```
// Stage 1 → Stage 2:
spawn_role({role:'planner', task:'Plan X. 
  RESEARCH FINDINGS: [extract key findings from researcher output]
  CONFIDENCE: [High/Medium/Low]'})

// Stage 4 → Stage 5:
spawn_role({role:'debugger', task:'Fix bug: [error].
  CONTEXT: [file paths, error output, relevant code]
  EXPECTED BEHAVIOR: [what should happen]'})
```

## Decision Gates

| Gate | Check | If fail |
|---|---|---|
| Research complete | Confidence ≥ Medium? 2+ sources? | Re-spawn researcher with refined task |
| Plan ready | Tasks with role/deps/wave? No TBD? | Return to planner with feedback |
| Plan approved | Reviewer verdict = ✅? | Return to planner → reviewer |
| Coder complete | Tests pass? All tasks done? | Debugger → retry |
| Final review | Reviewer verdict = ✅ / ⚠️? | Coder fixes → re-review |

## Parallel Safety

When dispatching parallel coders:
- Only dispatch tasks in the SAME wave that edit DIFFERENT files
- If two tasks edit the same file → serialize them (one wave apart)
- Wait for all parallel tasks to complete before starting the next wave

## Failure Recovery

- **Coder fails (tests fail, error)**: spawn debugger → fix → retry coder
- **Debugger can't find root cause**: escalate to user (ask_user) with full context
- **Reviewer finds Critical issues**: return to planner → reviewer loop (max 2 times)
- **Research confidence LOW**: re-spawn researcher with refined query (max 3 times)

## Self-Check Before Acting

When the user requests a complex task, ask:
1. Does this need research before planning? → researcher
2. Does this need a plan before coding? → planner + reviewer
3. Is this a debugging task? → debugger
4. Can multiple coding tasks run in parallel? → check waves
