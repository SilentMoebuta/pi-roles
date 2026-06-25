# DAG Visibility Smoke Test

## Prerequisites
- pi installed with pi-roles extension.
- A role that triggers dag_execute (or a manual prompt that makes the agent plan + execute a DAG).

## Steps
1. Start pi in a project: `pi`
2. Prompt the agent to do multi-step work that warrants a DAG, e.g.:
   "Use dag_execute to run: task-A (research X), task-B (research Y), task-C (depends on A, summarize). Plan it first."
3. While dag_execute runs, watch the TUI for a `dag-visibility` widget showing:
   - Header: `DAG — wave N/M`
   - Per-wave blocks with nodes and status symbols:
     - `○` queued
     - `◐` running
     - `✓` completed
     - `✗` failed (with `[error]`)
   - Dependency edges rendered as box-line connectors (├─ branch / └─ terminator), each showing the dep's current status symbol — not a text `[deps:]` label.
4. As waves progress, the widget should update (statuses flip queued→running→completed).
5. When dag_execute ends, the widget clears.
6. In non-tui modes (`pi -p` / `pi --mode rpc`), NO widget renders (no surface) — verify by checking that rpc/json output is unaffected.

## Pass criteria
- [ ] DAG widget appears during dag_execute (tui mode only)
- [ ] Node statuses visible and update over time
- [ ] Dependency edges rendered as ASCII box-line connectors (├─ / └─), each dep on its own line with its status symbol
- [ ] Widget clears on dag_execute end
- [ ] Concurrent DAGs (two dag_execute running) don't cross-talk — each toolCallId isolated, widget shows the most recent active one without dropping the other's state
- [ ] No token cost (details doesn't enter LLM context — AgentToolResult.details is UI-only metadata, like todo.ts)
- [ ] rpc/json/print modes: no widget, no errors
