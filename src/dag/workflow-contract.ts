import type { DAGNode, DAGSpec } from "./types";

export const WORKFLOW_CONTRACT_VERSION = 1 as const;

export type WorkflowKind = "direct" | "sequential" | "parallel" | "conditional" | "loop" | "map_reduce" | "handoff" | "dag";

export interface WorkflowTaskV1 {
  id: string;
  task: string;
  role?: string;
  dependsOn?: string[];
  expectedOutput?: string;
  resourceScope?: string[];
}

export interface WorkflowContractV1 {
  schemaVersion: typeof WORKFLOW_CONTRACT_VERSION;
  id: string;
  kind: WorkflowKind;
  tasks: WorkflowTaskV1[];
  condition?: { routerId: string; routes: Record<string, string[]> };
  loop?: { maxIterations: number; until: string };
  mapReduce?: {
    items: Array<{ key: string; input: string }>;
    mapRole?: string;
    mapTask: string;
    reduceTaskId: string;
  };
  metadata?: Record<string, unknown>;
}

export type WorkflowValidationV1 = { ok: true } | { ok: false; errors: string[] };

const WORKFLOW_KINDS = new Set<WorkflowKind>([
  "direct",
  "sequential",
  "parallel",
  "conditional",
  "loop",
  "map_reduce",
  "handoff",
  "dag",
]);

export function validateWorkflowContract(contract: WorkflowContractV1): WorkflowValidationV1 {
  const errors: string[] = [];
  if (!contract || typeof contract !== "object") return { ok: false, errors: ["workflow must be an object"] };
  if (contract.schemaVersion !== WORKFLOW_CONTRACT_VERSION) errors.push(`schemaVersion must be ${WORKFLOW_CONTRACT_VERSION}`);
  if (typeof contract.id !== "string" || !contract.id.trim()) errors.push("workflow id is required");
  if (!WORKFLOW_KINDS.has(contract.kind)) errors.push(`unknown workflow kind '${String(contract.kind)}'`);
  if (!Array.isArray(contract.tasks) || contract.tasks.length === 0) {
    errors.push("workflow requires at least one task");
    return { ok: false, errors };
  }
  const ids = new Set<string>();
  for (const task of contract.tasks) {
    if (!task || typeof task !== "object") { errors.push("task must be an object"); continue; }
    if (typeof task.id !== "string" || !task.id.trim()) errors.push("task id is required");
    else if (ids.has(task.id)) errors.push(`duplicate task id '${task.id}'`);
    ids.add(task.id);
    if (typeof task.task !== "string" || !task.task.trim()) errors.push(`task '${task.id ?? ""}' has no task text`);
  }
  for (const task of contract.tasks) {
    const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) errors.push(`task '${task.id ?? ""}' dependsOn must be an array`);
    for (const dep of dependencies) {
      if (!ids.has(dep)) errors.push(`task '${task.id}' depends on unknown task '${dep}'`);
      if (dep === task.id) errors.push(`task '${task.id}' cannot depend on itself`);
    }
  }
  if (contract.kind === "direct" && contract.tasks.length !== 1) errors.push("direct workflow requires exactly one task");
  if (contract.kind === "direct" && (contract.tasks[0]?.dependsOn?.length ?? 0) > 0) errors.push("direct workflow task cannot declare dependencies");
  if ((contract.kind === "sequential" || contract.kind === "handoff") && contract.tasks.length < 2) errors.push(`${contract.kind} workflow requires at least two tasks`);
  if (contract.kind === "parallel") {
    for (const task of contract.tasks) {
      if ((task.dependsOn?.length ?? 0) > 0) errors.push(`parallel task '${task.id}' cannot declare dependencies`);
    }
  }
  if (contract.kind === "conditional") {
    if (!contract.condition || typeof contract.condition !== "object") errors.push("conditional workflow requires condition");
    else {
      if (typeof contract.condition.routerId !== "string" || !ids.has(contract.condition.routerId)) errors.push(`condition router '${contract.condition.routerId}' is unknown`);
      if (!contract.condition.routes || typeof contract.condition.routes !== "object" || Array.isArray(contract.condition.routes)) errors.push("conditional workflow routes must be an object");
      else if (Object.keys(contract.condition.routes).length === 0) errors.push("conditional workflow requires at least one route");
      for (const [route, targets] of Object.entries(contract.condition.routes ?? {})) {
        if (!route.trim() || (Array.isArray(targets) && targets.length === 0)) errors.push("condition routes require a non-empty name and targets");
        if (!Array.isArray(targets)) { errors.push(`condition route '${route}' targets must be an array`); continue; }
        for (const target of targets) {
          if (!ids.has(target)) errors.push(`condition route '${route}' targets unknown task '${target}'`);
          if (target === contract.condition.routerId) errors.push(`condition route '${route}' cannot target its own router`);
        }
      }
    }
  }
  if (contract.kind === "loop") {
    if (!contract.loop) errors.push("loop workflow requires loop policy");
    else {
      if (!Number.isInteger(contract.loop.maxIterations) || contract.loop.maxIterations < 1 || contract.loop.maxIterations > 100) errors.push("loop.maxIterations must be an integer between 1 and 100");
      if (typeof contract.loop.until !== "string" || !contract.loop.until.trim()) errors.push("loop.until is required");
    }
    if (contract.tasks.length !== 1) errors.push("loop workflow requires exactly one loop body task");
    if ((contract.tasks[0]?.dependsOn?.length ?? 0) > 0) errors.push("loop body task cannot declare dependencies");
  }
  if (contract.kind === "map_reduce") {
    if (!contract.mapReduce) errors.push("map_reduce workflow requires mapReduce policy");
    else {
      if (!Array.isArray(contract.mapReduce.items)) errors.push("map_reduce.items must be an array");
      else if (contract.mapReduce.items.length === 0) errors.push("map_reduce requires at least one item");
      if (typeof contract.mapReduce.mapTask !== "string" || !contract.mapReduce.mapTask.trim()) errors.push("map_reduce.mapTask is required");
      const keys = new Set<string>();
      for (const item of Array.isArray(contract.mapReduce.items) ? contract.mapReduce.items : []) {
        if (!item || typeof item.key !== "string" || !/^[A-Za-z0-9._-]+$/.test(item.key) || keys.has(item.key)) errors.push(`map item key '${item?.key ?? ""}' is invalid or duplicated`);
        keys.add(item.key);
        if (ids.has(`map:${item.key}`)) errors.push(`generated map node 'map:${item.key}' collides with a declared task`);
      }
      if (!ids.has(contract.mapReduce.reduceTaskId)) errors.push(`reduce task '${contract.mapReduce.reduceTaskId}' is unknown`);
    }
  }
  if (errors.length === 0) {
    const cycle = findDependencyCycle(effectiveDependencies(contract));
    if (cycle) errors.push(`workflow contains a dependency cycle: ${cycle.join(" -> ")}`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Compile every acyclic workflow kind into the existing DAG adapter. */
export function compileWorkflowToDAG(contract: WorkflowContractV1): DAGSpec {
  const validation = validateWorkflowContract(contract);
  if (!validation.ok) throw new Error(`invalid workflow: ${validation.errors.join("; ")}`);
  if (contract.kind === "loop") throw new Error("loop workflows use executeBoundedWorkflowLoop instead of DAG compilation");

  const nodes: Record<string, DAGNode> = {};
  const tasks = contract.tasks;
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const depends = new Set(task.dependsOn ?? []);
    if ((contract.kind === "sequential" || contract.kind === "handoff") && index > 0) depends.add(tasks[index - 1].id);
    nodes[task.id] = {
      task: task.task,
      role: task.role,
      depends_on: [...depends],
      expected_output: task.expectedOutput,
      resource_scope: task.resourceScope,
    };
  }
  if (contract.kind === "conditional" && contract.condition) {
    nodes[contract.condition.routerId] = { ...nodes[contract.condition.routerId], routes: structuredClone(contract.condition.routes) };
    for (const targets of Object.values(contract.condition.routes)) {
      for (const target of targets) {
        const deps = new Set(nodes[target].depends_on ?? []);
        deps.add(contract.condition.routerId);
        nodes[target] = { ...nodes[target], depends_on: [...deps] };
      }
    }
  }
  if (contract.kind === "map_reduce" && contract.mapReduce) {
    const reduce = nodes[contract.mapReduce.reduceTaskId];
    const mapIds: string[] = [];
    for (const item of contract.mapReduce.items) {
      const id = `map:${item.key}`;
      if (nodes[id]) throw new Error(`generated map node '${id}' collides with a declared task`);
      mapIds.push(id);
      nodes[id] = {
        task: contract.mapReduce.mapTask.replaceAll("{{input}}", item.input).replaceAll("{{key}}", item.key),
        role: contract.mapReduce.mapRole,
      };
    }
    nodes[contract.mapReduce.reduceTaskId] = { ...reduce, depends_on: [...new Set([...(reduce.depends_on ?? []), ...mapIds])] };
  }
  return { nodes };
}

function effectiveDependencies(contract: WorkflowContractV1): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  contract.tasks.forEach((task, index) => {
    const deps = new Set(Array.isArray(task.dependsOn) ? task.dependsOn : []);
    if ((contract.kind === "sequential" || contract.kind === "handoff") && index > 0) deps.add(contract.tasks[index - 1].id);
    dependencies.set(task.id, deps);
  });
  if (contract.kind === "conditional" && contract.condition) {
    for (const target of Object.values(contract.condition.routes).flat()) dependencies.get(target)?.add(contract.condition.routerId);
  }
  if (contract.kind === "map_reduce" && contract.mapReduce) {
    for (const item of contract.mapReduce.items) dependencies.set(`map:${item.key}`, new Set());
    const reduce = dependencies.get(contract.mapReduce.reduceTaskId);
    for (const item of contract.mapReduce.items) reduce?.add(`map:${item.key}`);
  }
  return dependencies;
}

function findDependencyCycle(dependencies: Map<string, Set<string>>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return undefined;
    visiting.add(id);
    stack.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      if (!dependencies.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const id of dependencies.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

export interface WorkflowLoopIterationV1<T> {
  iteration: number;
  value: T;
  done: boolean;
}

export async function executeBoundedWorkflowLoop<T>(
  contract: WorkflowContractV1,
  execute: (input: { iteration: number; previous?: T; task: WorkflowTaskV1; until: string }) => Promise<{ value: T; done: boolean }>,
): Promise<{ status: "completed" | "limit_reached"; iterations: WorkflowLoopIterationV1<T>[] }> {
  const validation = validateWorkflowContract(contract);
  if (!validation.ok) throw new Error(`invalid workflow: ${validation.errors.join("; ")}`);
  if (contract.kind !== "loop" || !contract.loop) throw new Error("executeBoundedWorkflowLoop requires a loop workflow");
  const iterations: WorkflowLoopIterationV1<T>[] = [];
  let previous: T | undefined;
  for (let iteration = 1; iteration <= contract.loop.maxIterations; iteration++) {
    const result = await execute({ iteration, previous, task: contract.tasks[0], until: contract.loop.until });
    iterations.push({ iteration, value: result.value, done: result.done });
    previous = result.value;
    if (result.done) return { status: "completed", iterations };
  }
  return { status: "limit_reached", iterations };
}
