import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownPlanToDagSpec } from "../src/dag/plan-to-dag";

const SAMPLE_PLAN = `# Example Plan

**Goal:** Build auth system.

## File Structure
- Create: src/auth.ts
- Create: src/login.ts

## Task 1: Write auth middleware
**Role:** coder | **Deps:** [] | **Wave:** 0

**Files:**
- Create: \`src/auth.ts\`

- [ ] **Step 1: Write the test**
\`\`\`ts
test("auth", () => {});
\`\`\`

- [ ] **Step 2: Implement**
\`\`\`ts
export function auth() { return true; }
\`\`\`

## Task 2: Write login route
**Role:** coder | **Deps:** [1] | **Wave:** 0

- [ ] **Step 1: Implement**
\`\`\`ts
export function login() { return "ok"; }
\`\`\`

## Task 3: Code review
**Role:** reviewer | **Deps:** [1, 2] | **Wave:** 1

- [ ] **Step 1: Review auth and login**
- [ ] **Step 2: Report findings
`;

describe("plan_to_dag (P1)", () => {
  it("parses a sample plan into a correct DAGSpec", () => {
    const spec = markdownPlanToDagSpec(SAMPLE_PLAN);
    assert.ok(spec.nodes);
    assert.equal(Object.keys(spec.nodes).length, 3);
  });

  it("extracts correct role from each task", () => {
    const spec = markdownPlanToDagSpec(SAMPLE_PLAN);
    assert.equal(spec.nodes["task-1"].role, "coder");
    assert.equal(spec.nodes["task-2"].role, "coder");
    assert.equal(spec.nodes["task-3"].role, "reviewer");
  });

  it("maps numeric deps to named string node IDs", () => {
    const spec = markdownPlanToDagSpec(SAMPLE_PLAN);
    assert.deepEqual(spec.nodes["task-1"].depends_on, undefined, "no deps → undefined");
    assert.deepEqual(spec.nodes["task-2"].depends_on, ["task-1"], "dep 1 → task-1");
    assert.deepEqual(spec.nodes["task-3"].depends_on, ["task-1", "task-2"], "dep 1,2 → task-1,task-2");
  });

  it("task field contains the full body (heading + steps)", () => {
    const spec = markdownPlanToDagSpec(SAMPLE_PLAN);
    assert.ok(spec.nodes["task-1"].task.includes("Write auth middleware"), "heading text in task body");
    assert.ok(spec.nodes["task-1"].task.includes("Step 1"), "step in task body");
    assert.ok(spec.nodes["task-1"].task.includes("auth"), "code in task body");
  });

  it("throws when no Task N headings found", () => {
    assert.throws(() => markdownPlanToDagSpec("# No tasks here\n\nJust prose."), /no Task N headings/);
  });

  it("throws when a task depends on an unknown number", () => {
    const broken = `
## Task 1: Only task
**Role:** coder | **Deps:** [99] | **Wave:** 0

Some content.
`;
    assert.throws(() => markdownPlanToDagSpec(broken), /unknown task 99/);
  });

  it("handles multiple headings per task correctly (only first heading is the node)", () => {
    // Tasks may have sub-headings inside their body
    const plan = `
## Task 1: Main task
**Role:** coder | **Deps:** [] | **Wave:** 0

### Sub-heading inside task body
Some content.

### Another sub-heading
More content.

## Task 2: Second task
**Role:** reviewer | **Deps:** [1] | **Wave:** 1

Review content.
`;
    const spec = markdownPlanToDagSpec(plan);
    assert.equal(Object.keys(spec.nodes).length, 2);
    assert.ok(spec.nodes["task-1"].task.includes("Sub-heading"), "task body includes sub-headings");
    assert.ok(spec.nodes["task-1"].task.includes("Another sub-heading"), "task body includes second sub-heading");
    assert.ok(!spec.nodes["task-2"].task.includes("Sub-heading"), "task-2 body does NOT include task-1's content");
  });

  it("handles empty deps array gracefully", () => {
    const plan = `## Task 1: Solo task\n**Role:** coder | **Deps:** [] | **Wave:** 0\n\nBody.`;
    const spec = markdownPlanToDagSpec(plan);
    assert.equal(spec.nodes["task-1"].depends_on, undefined);
  });

  it("handles plan with only a single task", () => {
    const plan = `## Task 42: Lone task\n**Role:** debugger | **Deps:** [] | **Wave:** 0\n\nBody.`;
    const spec = markdownPlanToDagSpec(plan);
    assert.equal(Object.keys(spec.nodes).length, 1);
    assert.equal(spec.nodes["task-42"].role, "debugger");
    assert.equal(spec.nodes["task-42"].depends_on, undefined);
  });
});
