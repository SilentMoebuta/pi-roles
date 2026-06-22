# pi-roles

> Multi-roles for the [pi](https://github.com/earendil-works/pi) coding agent.
> **Status:** Phase 5 complete + production hardening Tier 1-6 (2026-06-20) + SOTA refresh (2026-06-20, main `694b539`). DAG executor, dynamic Send, checkpoint/resume, planner→DAG bridge, prod-wired tree-abort, proactive auto-compact + output-contract enforcement (reactive P0-4 enforcer + proactive G-OUT-2 tool_choice via before_provider_request), OTel telemetry hook (inert — wire `onTelemetry` to export). 259 tests, tsc 0.

## What it does

pi-roles provides a **multi-role subagent orchestration layer** for pi:

- **`spawn_role`** — spawn a role-scoped subagent (researcher, coder, reviewer, planner, debugger) with persona injection, tool whitelist, step limit, model override, and depth-limited recursion.
- **`dag_execute`** — execute a DAG of subagent roles with topological waves, parallel spawn per wave, `Promise.allSettled` barrier (partial failure isolation), result aggregation, and upstream-data injection.
- **`dag_resume`** — resume a DAG from a serialized checkpoint (skip completed waves, preserve prior results).
- **`report_role_result`** — output-contract tool every role must call once; structured `{findings, artifacts}` payload extracted by the service from child session messages.

### In-place persona switching (main agent)

- **`/role <name>`** — adopt a role's persona **in the main session** (no subagent spawn). The role's prompt body is injected into every turn's system prompt via `before_agent_start`, persisted as a `pi-roles:active-role` session entry (append-only, last-wins). Useful for deep, open-ended conversation in a role's voice (e.g. `/role pm` to think through product direction with you).
- **`/role clear`** — revert to the default persona (next turn stops injecting; no snapshot stored). A `display:false` transition steer acknowledges the prior role context for continuity.
- **`/role`** — show the currently active role (or `none`).

Persona injection only — the main session's tools / model / thinkingLevel are **not** changed, and role `*-skills/` directories are **not** loaded (those require a reload; for a role's full skill flow use `spawn_role` or the `/pm-*` commands). When switching with context usage ≥ 70%, a non-blocking reminder suggests starting a fresh conversation. This is orthogonal to an active `/goal` — both can run together.

Self-written execution layer — no dependency on `@gotgenes/pi-subagents` (replaced with own `SubagentsService`, `SubagentRegistry`, `SubagentState`).

## Architecture

```
src/
  subagent/
    service.ts        — SubagentsService (spawn/waitForResult/abort)
    registry.ts       — SubagentRegistry (in-process map + completion promises)
    runner.ts         — runSubagent (session.prompt with safety controls)
    spawn.ts          — spawnRole (pi primitives: createAgentSession + SessionManager)
    spawn-role-tool.ts — spawn_role tool (role resolution, skill isolation, customTools)
    handle.ts         — AgentHandle (pure-data lifecycle handle)
    state.ts          — SubagentState (FSM: queued→running→completed/aborted/error)
    skills-override.ts — makeRoleSkillsOverride (per-role domainSkill injection)
    session-start-handler.ts — add report_role_result to role sessions (additive)
    agent-end-fallback.ts     — (retained but not wired; children have own extensions)
  dag/
    types.ts          — DAGSpec, DAGNode, DAGResult, WaveResult, NodeResult, DAGProgress
    planner.ts        — planWaves (Kahn's algorithm, level-by-level)
    executor.ts       — executeDAGCore / executeDAG (wave loop, dual allSettled barrier,
                         maxConcurrent semaphore, dynamic-fanout, upstream-results injection,
                         progress callbacks)
    state.ts          — aggregateWaves, errorContextPrefix, upstreamResultsPrefix
    send.ts           — Send, DynamicNode, DynamicNodeContext, fanOutSends
    checkpoint.ts     — serialize/deserialize checkpoint, resumeDAG
    dag-execute-tool.ts — dag_execute tool (LLM entry point with full role resolution)
    dag-resume-tool.ts  — dag_resume tool (resumes from serialized checkpoint)
    plan-to-dag.ts    — markdownPlanToDagSpec (planner → DAGSpec bridge, P1)
  contract.ts         — validateReport, buildStructuredError (output-contract schema)
  report-tool.ts      — makeReportTool (report_role_result definition)
  roles.ts            — parseRoleFrontmatter (from roles/*.md)
  active-role.ts      — pure helpers for /role (persona prompt builder, branch parser)
  role-commands.ts    — /role command (switch/clear/show + context reminder)
roles/
  coder.md            — read/bash/write/edit/grep/find/ls
  reviewer.md         — read/bash/grep/find/ls
  researcher.md       — read/bash/web_search/fetch_content...
  planner.md          — read/bash/grep/find/ls/web_search/fetch_content...
  debugger.md         — read/bash/write/edit/grep/find/ls
  {role}-skills/      — per-role methodology skills (SKILL.md)
```

## Test coverage

249 tests, tsc exit 0. `npx tsx --test __tests__/*.test.ts`.

## Design docs

Design rationale and per-fix criteria IDs are documented in the commit history (each commit cites its criterion, e.g. c6b51c5 / c0e3ff6 / c05c88d / caff7f9 / c51ac1a) and in the per-role methodology `SKILL.md` files under `roles/*-skills/`. There are no in-repo design-doc files.

## Verification probes (independent process, bypasses pi module cache)

- `npx tsx scripts/probe-report-role-result-live-v2.ts` — real spawn_role path, customTools fix verified
- `npx tsx scripts/probe-phase5-smoke.ts` — full live smoke: report_role_result payload + dynamic Send DAG
- `npx tsx scripts/probe-real-pi-primitives.ts` — pi primitives integration verified
