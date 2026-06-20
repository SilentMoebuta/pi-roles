// plan_to_dag — converts a planner role's markdown plan into a DAGSpec
// consumable by the dag_execute tool. Bridges the structural gap between
// "planner outputs a human-readable markdown plan with numbered tasks and
// numeric dep references" and "dag_execute expects named-string node IDs".
//
// Input format (planner's report_role_result findings, or the raw markdown):
//
//   ### Task 1: Fix clone bug — AgentHandle pure-data
//   **Role:** debugger | **Deps:** [] | **Wave:** 0
//   **Files:**
//   - Modify: `src/subagent/handle.ts`
//   - [ ] **Step 1: Write the failing test**
//   ```ts
//   code here
//   ```
//
//   ### Task 2: DAG types
//   **Role:** coder | **Deps:** [1] | **Wave:** 1
//   ...
//
// Conversion:
// - Task number → node ID "task-N" (e.g. Task 1 → "task-1")
// - **Role:** X → DAGNode.role
// - Full task content (heading + body) → DAGNode.task
// - Numeric deps [N,M] → depends_on: ["task-N", "task-M"]
// - **Wave:** is ignored (planWaves re-sorts topologically)

import type { DAGSpec, DAGNode } from "./types";

/** Extract the text content between a task heading and the next task heading
 *  (or end of text). Only stops at task-level headings (##/### Task N:...).
 *  Sub-headings (### anything else) are kept inside the task body. */
function takeSection(lines: string[], startIdx: number): { text: string; endIdx: number } {
  let i = startIdx + 1;
  while (i < lines.length && !/^#{2,3}\s+Task\s+\d+/i.test(lines[i])) {
    i++;
  }
  // Consume trailing blank lines before the next task heading.
  let endIdx = i;
  while (endIdx > startIdx + 1 && lines[endIdx - 1].trim() === "") {
    endIdx--;
  }
  return { text: lines.slice(startIdx, endIdx).join("\n"), endIdx };
}

/**
 * Convert a planner-produced markdown plan string into a DAGSpec.
 * Parses `### Task N: Title` sections, extracts role/deps, maps numeric
 * deps to named string node IDs.
 *
 * @returns DAGSpec with nodes keyed by "task-N" — ready for dag_execute.
 * @throws if no tasks are found or if a dep references an unknown task number.
 */
export function markdownPlanToDagSpec(markdown: string): DAGSpec {
  const lines = markdown.split("\n");
  const taskNodes: Array<{ num: number; title: string; headingLine: number }> = [];

  // First pass: find all task headings.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+Task\s+(\d+)[\s:—\-–]+(.+)/i);
    if (m) {
      taskNodes.push({ num: parseInt(m[1], 10), title: m[2].trim(), headingLine: i });
    }
  }

  // Also support the simplified format: `## Task N: ...` (some plans use ##)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+Task\s+(\d+)[\s:—\-–]+(.+)/i);
    if (m && !taskNodes.some(t => t.headingLine === i)) {
      taskNodes.push({ num: parseInt(m[1], 10), title: m[2].trim(), headingLine: i });
    }
  }

  if (taskNodes.length === 0) {
    throw new Error("no Task N headings found in plan — expected `### Task N: Title` blocks");
  }

  // Sort by heading line so we process in document order.
  taskNodes.sort((a, b) => a.headingLine - b.headingLine);

  // Second pass: for each task, extract role/deps and the full task body.
  const nodes: Record<string, DAGNode> = {};
  const numToId = new Map<number, string>();
  for (const tn of taskNodes) {
    numToId.set(tn.num, `task-${tn.num}`);
  }

  for (const tn of taskNodes) {
    const { text: body } = takeSection(lines, tn.headingLine);
    // Parse metadata from the section head (the heading line + the metadata line just after)
    const roleMatch = body.match(/\*\*Role:\*\*\s*(\w[\w-]*)/);
    const depsMatch = body.match(/\*\*Deps:\*\*\s*\[([^\]]*)\]/);
    if (!roleMatch) {
      throw new Error(`Task ${tn.num} ("${tn.title}") missing **Role:** field`);
    }
    const role = roleMatch[1];
    const depNums: number[] = depsMatch && depsMatch[1].trim() !== ""
      ? depsMatch[1].split(",").map((s: string) => parseInt(s.trim(), 10)).filter((n: number) => !isNaN(n))
      : [];
    // Resolve numeric deps to named IDs
    const depends_on: string[] = [];
    for (const dn of depNums) {
      const id = numToId.get(dn);
      if (!id) throw new Error(`Task ${tn.num} depends on unknown task ${dn}`);
      depends_on.push(id);
    }

    nodes[`task-${tn.num}`] = { role, task: body.trim(), depends_on: depends_on.length > 0 ? depends_on : undefined };
  }

  return { nodes };
}
