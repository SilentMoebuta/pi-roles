# pi-roles

## Nested progress and report repair

`spawn_role` forwards a sanitized progress stream to its parent tool update:
phase, role, agent ID, turn count, tool name, timestamps, and session file. It
does not forward model text or tool arguments. Child sessions also have a
maximum tool duration so a hung reviewer cannot hold the parent forever.

Use the `report-reviewer` role for addressable report findings and
`report-reviser` for bounded edits to existing artifacts. Full rewrites are an
explicit exceptional path for global structural defects; ordinary findings are
repaired in place and then re-reviewed.

> Multi-roles for the [pi](https://github.com/earendil-works/pi) coding agent.
> **Status:** Phase 5 complete + production hardening Tier 1-6 (2026-06-20) + SOTA refresh (2026-06-20, main `694b539`). DAG executor, dynamic Send, checkpoint/resume, planner→DAG bridge, prod-wired tree-abort, proactive auto-compact + output-contract enforcement (reactive P0-4 enforcer + proactive G-OUT-2 tool_choice via before_provider_request), OTel telemetry hook (inert — wire `onTelemetry` to export).

## What it does

pi-roles provides a **multi-role subagent orchestration layer** for pi:

- **`spawn_role`** — spawn a role-scoped subagent (researcher, coder, reviewer, planner, debugger) with persona injection, tool whitelist, step limit, model override, and depth-limited recursion.
- **`dag_execute`** — execute an admitted DAG with adaptive ready-node scheduling (or legacy wave barriers), bounded concurrency, write-scope leases, result aggregation, and upstream-data injection. Bounded result-driven dispatch can add validated scheduler-visible children from a dispatcher's structured report. New nodes can opt into the semantic `expected_output` + `consumers` contract; leaf nodes declare `$result`. The `role` field remains optional for legacy/default subagents.
- **`dag_resume`** — resume a DAG from a V1 wave or V2 explicit-node checkpoint without replaying terminal nodes or already-expanded dispatchers.
- **`workflow_execute`** — execute the shared V1 workflow contract for direct, sequential, parallel, conditional, bounded loop, map/reduce, handoff, and DAG workflows. Acyclic kinds compile into `dag_execute`; loop iterations use a bounded runtime with the same role/resource adapter.
- **`batch_execute`** — run a typed batch manifest through the same role adapter, resource lease table, abort signal, and typed result projection; pass a prior aggregate with `mode: "failed_only"` to retry only retryable failures.
- **`report_role_result`** — output-contract tool every role must call once; structured `{findings, artifacts}` payload extracted by the service from child session messages.

The reusable runtime APIs also include `executeBatchManifest` for bounded batch
execution with failed-only retry and resource leases, and
`resolveProfileLayers` for organization/user/repository composition. Profile
components can carry ordinary settings, skills, MCP configuration, hooks, and
project policy; organization-enforced values are applied last. These APIs are
project-neutral and do not encode any report-specific role or path.

### Frontier progress

DAG progress is presented as the scheduler frontier rather than as a wave timeline:

- **Running** nodes are executing now; **Ready** nodes have satisfied dependencies and are waiting for scheduler capacity or a write-scope lease.
- **Blocked** nodes are waiting on the `waitingOn` dependencies (or an explicit legacy wave barrier); **Settled** includes completed, skipped, and failed nodes. Settled is not a success signal: terminal `partial` and `failed` outcomes, plus failed-node details, remain explicit.
- The **critical** frontier uses `path` to identify the longest remaining structural path for scheduler ordering; it is not a time estimate. Route decisions and scheduler-generated children retain their `route` and parent provenance in progress details.
- `currentWave`, `totalWaves`, and per-node `wave` remain compatibility fields for older integrations and `scheduler:"wave"`; they are not the primary progress model.
- The display intentionally has no percentage. Node counts describe execution activity and never act as completion criteria.

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
    executor.ts       — executeDAGCore / executeDAG (ready/wave scheduler, runtime concurrency,
                         scope leases, validated dynamic fan-out, upstream-results injection)
    validate.ts       — topology, role, semantic-contract, and dispatch admission
    state.ts          — aggregateWaves, errorContextPrefix, upstreamResultsPrefix
    send.ts           — Send, DynamicNode, DynamicNodeContext, fanOutSends
    checkpoint.ts     — serialize/deserialize checkpoint, resumeDAG
    dag-execute-tool.ts — dag_execute tool (LLM entry point with full role resolution)
    workflow-execute-tool.ts — unified workflow contract adapter
    batch-execute-tool.ts — batch_execute tool (typed manifest execution and failed-only retry)
    dag-resume-tool.ts  — dag_resume tool (resumes from serialized checkpoint)
    plan-to-dag.ts    — markdownPlanToDagSpec (planner → DAGSpec bridge, P1)
    batch-runtime.ts    — batch manifest/aggregate/failed-only retry runtime
  profile-layers.ts     — organization/user/repository profile composition
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

Run `npm test` and `npm run typecheck`. Published V1 schemas for workflow,
batch manifest/result, profile layers, role results, and reviewer payloads live
under `schemas/`.

## Design docs

Design rationale and per-fix criteria IDs are documented in the commit history (each commit cites its criterion, e.g. c6b51c5 / c0e3ff6 / c05c88d / caff7f9 / c51ac1a) and in the per-role methodology `SKILL.md` files under `roles/*-skills/`. There are no in-repo design-doc files.

## Verification probes (independent process, bypasses pi module cache)

- `npx tsx scripts/probe-report-role-result-live-v2.ts` — real spawn_role path, customTools fix verified
- `npx tsx scripts/probe-phase5-smoke.ts` — full live smoke: report_role_result payload + dynamic Send DAG
- `npx tsx scripts/probe-real-pi-primitives.ts` — pi primitives integration verified
