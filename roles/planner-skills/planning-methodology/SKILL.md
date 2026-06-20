---
name: planning-methodology
description: "Structured planning methodology for AI coding agents: scope decomposition, file structure mapping, bite-sized task breakdown, role assignment, dependency DAG, parallel waves, and no-placeholder enforcement. Use when asked to plan, design architecture, or produce implementation plans for multi-step or multi-file changes."
---

# Planning Methodology

## Purpose

Produce implementation plans that are **machine-readable execution protocols** — not vague design docs. Every step must be concrete enough that a subagent with zero context can execute it correctly. No TBD, no "add error handling", no placeholders.

## Phased Workflow

### Phase 1: Understand the Problem (Codebase Research)

Before designing, understand what exists:
1. Read relevant source files (read/grep/find)
2. Run diagnostic commands (bash) to confirm current behavior
3. Identify existing patterns and conventions in the codebase
4. Note any technical debt or constraints that affect the design

### Phase 2: Research the Landscape (External Research)

1. Search web for standard patterns and their failure modes (web_search)
2. Look at how similar projects solve the problem
3. Note trade-offs documented by others who've attempted this
4. Find at least 2 references for each technology decision

### Phase 3: Scope Check

If the task spans multiple independent subsystems:
- Break into separate plans — one per subsystem
- Each plan must produce working, testable software on its own
- If impossible to break: explain why and proceed with a single plan

### Phase 4: File Structure Mapping

Before decomposing tasks, map which files will be created or modified:
- Design units with clear boundaries and well-defined interfaces
- Each file should have one clear responsibility
- Files that change together should live together
- Follow established codebase patterns; don't restructure unless necessary

### Phase 5: Propose 2-3 Approaches

For any non-trivial design decision:
1. Present 2-3 meaningfully different approaches (not straw-men)
2. Compare: complexity, risk, maintenance burden, performance, alignment with existing patterns
3. Lead with a clear recommendation grounded in research findings

### Phase 6: Task Decomposition

Break the recommendation into bite-sized, ordered tasks:
- Each task = one action (2-5 minutes of work)
- Tasks include: what file to touch, what to write, what command to run, expected output
- Use checkbox syntax (`- [ ]`) for tracking
- Zero placeholders — every step contains actual code, commands, and expected output

### Phase 7: Role Assignment

Assign each task to the most appropriate role:
- `coder` — writing code, tests, docs, config
- `debugger` — bug investigation, fixing
- `researcher` — web search, documentation lookup
- `reviewer` — code review, quality checks

### Phase 8: Dependency DAG + Parallel Waves

1. Tag each task with `deps: [N, M]` — which prior tasks must complete first
2. Group tasks into waves via topological sort:
   - Wave 0: tasks with no dependencies → run in parallel
   - Wave 1: tasks depending only on Wave 0 outputs → parallel after Wave 0
   - Continue until all tasks assigned
3. Safety: tasks editing the SAME file must not be in the same wave

### Phase 9: Self-Review

Before delivering, check:
1. Any TBD, TODO, or vague instruction? Fix them.
2. Are file paths exact? (not "the auth module", but "src/auth/login.ts:45-67")
3. Can a coder subagent read any task out of order and execute it correctly?

---

## Plan Output Format

```markdown
# [Feature Name] Implementation Plan

**Goal:** One sentence describing what this builds
**Architecture:** 2-3 sentences about approach
**Tech Stack:** Key technologies

## Files

| File | Action | Purpose |
|------|--------|---------|
| src/... | Create | ... |
| src/... | Modify | ... |

## Tasks

### Task 1: [Title]
**Role:** coder | **Deps:** []

- [ ] **Step 1: Write test**
  ```lang
  code
  ```
- [ ] **Step 2: Run test → FAIL**
- [ ] **Step 3: Write implementation**
  ```lang
  code
  ```
- [ ] **Step 4: Run test → PASS**
- [ ] **Step 5: Commit**

### Task 2: [Title]
**Role:** reviewer | **Deps:** [1]
...
```

---

## Anti-Patterns

- **Vague steps** ("add error handling", "write tests", "implement the feature") — no placeholders. Every step shows exactly what to write.
- **Missing dependencies** — tasks that need a file created in Task 5 but are scheduled in Wave 0.
- **Straw-man alternatives** — proposing options you wouldn't actually recommend.
- **Ignoring existing patterns** — plans that violate codebase conventions without justification.
- **Single-file conflict** — two tasks editing the same file in the same wave.

## Architecture Decision Records (ADR)

For any non-trivial architecture decision in the plan, record an ADR (Nygard / MADR format — MORE relevant in 2026, adopted by AWS/Spotify/ThoughtWorks). Minimal template:

```
## ADR-NN: <decision title>
- Status: Proposed | Accepted | Superseded
- Context: what forces are at play? what constraints?
- Decision: what we chose
- Consequences: positive + negative + neutral
```

Keep ADRs in the plan doc (or `docs/decisions/`). They make the plan auditable + reversible. Don't over-document trivial choices.

## Cynefin Framework — Match Methodology to Problem Domain

Before planning, classify the problem (Snowden & Boone, HBR 2007 — still current, no successor):

- **Simple/Clear** (known, best practice) → apply the standard recipe. Don't over-plan.
- **Complicated** (knowable, expert analysis) → investigate options, pick via ADR. Multiple valid answers.
- **Complex** (emergent, probe-sense-respond) → plan probes/experiments, NOT big-up-front design. Iterate.
- **Chaotic** (novel, act-sense-respond) → stabilize first, then move to complex. Don't plan, act.

Prevents BDUF (big-design-up-front) on complex problems where the plan will be wrong, and prevents under-planning on complicated problems where the design matters. State the classification in the plan.

## INVEST Criteria — Per-Task Gate

Every task in the plan should satisfy INVEST (Agile standard, still SOTA):
- **I**ndependent, **N**egotiable, **V**aluable, **E**stimable, **S**mall (2-5 min for superpowers), **T**estable

Reject tasks that fail INVEST — split or rephrase them.
