// DAG spec pre-validation — prevents silent failures from bad depends_on refs
// or orphaned nodes that the planner would drop. Called before executeDAG.
import type { DAGAdmissionDiagnostic, DAGNode, DAGSpec } from "./types";
import type { Send } from "./send";
import { normalizeWriteScope } from "./scope";
import { normalizeResourceUri } from "./resource-lease";

export const DEFAULT_MAX_DISPATCH_CHILDREN = 8;
export const HARD_MAX_DISPATCH_CHILDREN = 20;
export const HARD_MAX_DISPATCH_DEPTH = 2;
export const FINAL_RESULT_CONSUMER = "$result";
export const GENERATED_PARENT_CONSUMER = "$parent";

export interface DAGValidation {
  ok: boolean;
  errors: string[];
  diagnostics: DAGAdmissionDiagnostic[];
}

export interface DAGValidationOptions {
  /** Parent ids already proven by dispatch expansion metadata. */
  expandedDispatches?: ReadonlySet<string>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A semantic contract is opt-in for compatibility. Once any contract field is
 *  present, the complete contract is required and validation fails closed. */
export function hasSemanticContract(node: Pick<DAGNode, "expected_output" | "consumers">): boolean {
  return node.expected_output !== undefined || node.consumers !== undefined;
}

function validateConsumerList(
  owner: string,
  consumers: unknown,
  allowedReserved: string,
): string[] {
  if (!Array.isArray(consumers) || consumers.length === 0) {
    return [`${owner} consumers must be a non-empty array`];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const consumer of consumers) {
    if (!isNonEmptyString(consumer)) {
      errors.push(`${owner} consumers must contain only non-empty strings`);
      continue;
    }
    const normalized = consumer.trim();
    if (normalized.startsWith("$") && normalized !== allowedReserved) {
      errors.push(`${owner} uses unsupported reserved consumer '${normalized}'`);
    }
    if (seen.has(normalized)) errors.push(`${owner} declares duplicate consumer '${normalized}'`);
    seen.add(normalized);
  }
  return errors;
}

/** Validate declared or runtime-generated fan-out children before any child is
 *  spawned. Legacy Sends remain valid; semantic parents require stable keys and
 *  complete child contracts so dynamic dispatch cannot bypass DAG admission. */
export function validateGeneratedSends(
  parentId: string,
  sends: unknown,
  requireSemanticContract = false,
  knownRoles?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string[] {
  if (!Array.isArray(sends)) return [`node '${parentId}' generated sends must be an array`];
  const errors: string[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < sends.length; index++) {
    const send = sends[index] as Partial<Send> | null;
    const owner = `node '${parentId}' send[${index}]`;
    if (!send || typeof send !== "object") {
      errors.push(`${owner} must be an object`);
      continue;
    }
    if (!isNonEmptyString(send.role)) errors.push(`${owner} role must be a non-empty string`);
    else if (knownRoles && !knownRoles.has(send.role)) errors.push(`${owner} references unknown role '${send.role}'`);
    if (!(isNonEmptyString(send.arg) || (send.arg !== null && typeof send.arg === "object" && !Array.isArray(send.arg)))) {
      errors.push(`${owner} arg must be a non-empty task string or an object`);
    }

    const declaresContract = send.key !== undefined || send.expected_output !== undefined || send.consumers !== undefined;
    if (!requireSemanticContract && !declaresContract) continue;
    if (send.arg !== null && typeof send.arg === "object" && !Array.isArray(send.arg) && Object.keys(send.arg).length === 0) {
      errors.push(`${owner} arg object must describe a non-empty task`);
    }
    if (!isNonEmptyString(send.key)) {
      errors.push(`${owner} key must be a non-empty stable identifier`);
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(send.key.trim())) {
      errors.push(`${owner} key '${send.key}' must use only letters, digits, '.', '_', ':', or '-'`);
    } else if (keys.has(send.key.trim())) {
      errors.push(`node '${parentId}' generated duplicate send key '${send.key.trim()}'`);
    } else {
      keys.add(send.key.trim());
    }
    if (!isNonEmptyString(send.expected_output)) errors.push(`${owner} expected_output must be a non-empty string`);
    errors.push(...validateConsumerList(owner, send.consumers, GENERATED_PARENT_CONSUMER));
    if (Array.isArray(send.consumers)) {
      for (const consumer of send.consumers) {
        if (isNonEmptyString(consumer) && consumer.trim() !== GENERATED_PARENT_CONSUMER) {
          errors.push(`${owner} consumer '${consumer.trim()}' must be '${GENERATED_PARENT_CONSUMER}' because generated results are aggregated by their parent node`);
        }
      }
      if (!send.consumers.some((consumer) => isNonEmptyString(consumer) && consumer.trim() === GENERATED_PARENT_CONSUMER)) {
        errors.push(`${owner} must declare '${GENERATED_PARENT_CONSUMER}' as its consumer`);
      }
    }
  }
  return errors;
}

function normalizedSentence(value: string): string {
  return value.trim().toLowerCase().replace(/[.!。！]+$/u, "").replace(/\s+/g, " ");
}

/** These deliberately match only explicit no-value phrases. More general
 *  setup/synthesis language is advisory territory because text heuristics
 *  cannot determine whether a transformation is meaningful. */
function isExplicitSetupOnly(node: DAGNode): boolean {
  if (!isNonEmptyString(node.task) || !isNonEmptyString(node.expected_output)) return false;
  const task = normalizedSentence(node.task);
  const output = normalizedSentence(node.expected_output);
  const english = /^(?:setup|set up|initialize|prepare) (?:the )?(?:context|workspace|environment|repository|repo)(?: only)?$/.test(task)
    && /^(?:context|workspace|environment|repository|repo) (?:ready|prepared|initialized|set up)$/.test(output);
  const chinese = /^(?:设置|初始化|准备)(?:上下文|工作区|环境|仓库)(?:即可|而已)?$/.test(task)
    && /^(?:上下文|工作区|环境|仓库)(?:已就绪|已准备|已初始化|设置完成)$/.test(output);
  return english || chinese;
}

function isExplicitConcatenationOnly(node: DAGNode): boolean {
  if (!isNonEmptyString(node.task) || !isNonEmptyString(node.expected_output)) return false;
  const task = normalizedSentence(node.task);
  const output = normalizedSentence(node.expected_output);
  const english = /^(?:concatenate|join) (?:the )?(?:upstream )?(?:results|outputs|text)(?: verbatim| only)?$/.test(task)
    && /^(?:concatenated|joined|combined) (?:results|output|text)$/.test(output);
  const chinese = /^(?:逐字)?拼接(?:上游)?(?:结果|输出|文本)(?:即可|而已)?$/.test(task)
    && /^(?:已拼接|拼接后的?)(?:结果|输出|文本)$/.test(output);
  return english || chinese;
}

/** Validate a DAG spec before execution. Catches:
 *  - depends_on references to non-existent node IDs
 *  - orphaned nodes (no path from root, missing/invalid deps that prevent scheduling)
 *  Reports clear errors instead of silently dropping nodes. */
export function validateDAG(
  spec: DAGSpec,
  knownRoles?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  options: DAGValidationOptions = {},
): DAGValidation {
  const nodeIds = Object.keys(spec.nodes);
  const errors: string[] = [];
  const diagnostics: DAGAdmissionDiagnostic[] = [];
  const hasRole = (role: string) => knownRoles?.has(role) ?? true;
  const directConsumers = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const [consumerId, node] of Object.entries(spec.nodes)) {
    for (const dependencyId of node.depends_on ?? []) directConsumers.get(dependencyId)?.push(consumerId);
  }

  const semanticNodeIds = nodeIds.filter((id) => hasSemanticContract(spec.nodes[id]));
  if (semanticNodeIds.length > 0 && semanticNodeIds.length < nodeIds.length) {
    diagnostics.push({
      severity: "advisory",
      code: "mixed_semantic_contract",
      message: `DAG mixes ${semanticNodeIds.length} contracted node(s) with ${nodeIds.length - semanticNodeIds.length} legacy node(s); migrate the remaining nodes before enforcing graph-wide admission`,
    });
  }
  if (semanticNodeIds.length === nodeIds.length && nodeIds.length === 1
    && spec.nodes[nodeIds[0]].dispatch === undefined
    && !options.expandedDispatches?.has(nodeIds[0])) {
    errors.push("semantic DAG admission requires more than one node; use direct or specialist execution for a single workflow");
  }

  // 1. Check all depends_on refs exist
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.role && node.roleDef) {
      errors.push(`node '${id}' cannot provide both role and roleDef`);
    }
    if (node.role && !hasRole(node.role)) {
      errors.push(`node '${id}' references unknown role '${node.role}'`);
    }
    if (node.timeout_ms !== undefined && (!Number.isFinite(node.timeout_ms) || node.timeout_ms <= 0)) {
      errors.push(`node '${id}' timeout_ms must be > 0`);
    }
    if (node.priority !== undefined && !Number.isFinite(node.priority)) {
      errors.push(`node '${id}' priority must be a finite number`);
    }
    if (node.dispatch !== undefined && !hasSemanticContract(node)) {
      errors.push(`node '${id}' dispatch requires expected_output and consumers`);
    }
    if (hasSemanticContract(node)) {
      if (!isNonEmptyString(node.task)) {
        errors.push(`node '${id}' task must state a non-empty independent problem when a semantic contract is declared`);
      }
      if (!isNonEmptyString(node.expected_output)) {
        errors.push(`node '${id}' expected_output must be a non-empty string when a semantic contract is declared`);
      }
      errors.push(...validateConsumerList(`node '${id}'`, node.consumers, FINAL_RESULT_CONSUMER));
      if (Array.isArray(node.consumers)) {
        const declared = new Set(node.consumers.filter(isNonEmptyString).map((consumer) => consumer.trim()));
        for (const consumer of declared) {
          if (consumer === FINAL_RESULT_CONSUMER) continue;
          if (!spec.nodes[consumer]) {
            errors.push(`node '${id}' consumer '${consumer}' does not exist in spec.nodes`);
          } else if (!(spec.nodes[consumer].depends_on ?? []).includes(id)) {
            errors.push(`node '${id}' consumer '${consumer}' must directly depend_on '${id}'`);
          }
        }
        for (const consumer of directConsumers.get(id) ?? []) {
          if (!declared.has(consumer)) errors.push(`node '${id}' omits direct consumer '${consumer}' from consumers`);
        }
        if ((directConsumers.get(id) ?? []).length === 0 && !declared.has(FINAL_RESULT_CONSUMER)) {
          errors.push(`leaf node '${id}' must declare '${FINAL_RESULT_CONSUMER}' as a consumer`);
        }
      }
      if (isExplicitSetupOnly(node)) {
        errors.push(`node '${id}' is setup-only and has no independently useful output; fold it into its consumer task`);
      }
      if (isExplicitConcatenationOnly(node)) {
        errors.push(`node '${id}' only concatenates upstream text; consume upstream results directly or declare a substantive synthesis outcome`);
      }
      if ((node.dynamic || node.sends) && node.dispatch === undefined) {
        errors.push(`node '${id}' must declare a dispatch contract before semantic result-driven fan-out`);
      }
    }
    for (const scope of node.write_scope ?? []) {
      try { normalizeWriteScope(scope); }
      catch (error) { errors.push(`node '${id}' ${(error as Error).message}`); }
    }
    for (const resource of node.resource_scope ?? []) {
      try { normalizeResourceUri(resource); }
      catch (error) { errors.push(`node '${id}' ${(error as Error).message}`); }
    }
    const maxChildren = node.dispatch?.maxChildren ?? DEFAULT_MAX_DISPATCH_CHILDREN;
    if (!Number.isInteger(maxChildren) || maxChildren < 1 || maxChildren > HARD_MAX_DISPATCH_CHILDREN) {
      errors.push(`node '${id}' dispatch.maxChildren must be an integer between 1 and ${HARD_MAX_DISPATCH_CHILDREN}`);
    }
    if (node.dispatch !== undefined && node.sends && node.sends.length > maxChildren) {
      errors.push(`node '${id}' declares ${node.sends.length} sends, exceeding maxChildren=${maxChildren}`);
    }
    if (node.sends) errors.push(...validateGeneratedSends(id, node.sends, node.dispatch !== undefined || hasSemanticContract(node), knownRoles));
    if (node.sends !== undefined && node.dynamic !== undefined) {
      errors.push(`node '${id}' cannot combine sends with dynamic`);
    }
    for (const dep of (node.depends_on ?? [])) {
      if (!spec.nodes[dep]) {
        errors.push(`node '${id}' depends_on '${dep}' which does not exist in spec.nodes`);
      }
    }
  }

  // Admission diagnostics are intentionally structural and non-blocking. A
  // fork/join can be a good graph, and same-role stages can be meaningful; the
  // caller gets an explicit prompt to justify them rather than a text-guessing
  // rejection.
  let waves: string[][] = [];
  const remainingForWaves = new Set(nodeIds);
  const settledForWaves = new Set<string>();
  while (remainingForWaves.size > 0) {
    const ready = [...remainingForWaves].filter((id) => (spec.nodes[id].depends_on ?? []).every((dep) => settledForWaves.has(dep)));
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) {
      remainingForWaves.delete(id);
      settledForWaves.add(id);
    }
  }
  if (waves.length === 3 && waves[0].length === 1 && waves[1].length > 1 && waves[2].length === 1) {
    diagnostics.push({
      severity: "advisory",
      code: "fork_join_template",
      message: "DAG has the common 1 -> N -> 1 template; verify the root and join perform substantive work instead of setup and text concatenation",
    });
  }
  for (const [id, node] of Object.entries(spec.nodes)) {
    const consumers = directConsumers.get(id) ?? [];
    if (consumers.length !== 1) continue;
    const consumerId = consumers[0];
    const consumer = spec.nodes[consumerId];
    if (!consumer || (consumer.depends_on ?? []).length !== 1) continue;
    if (node.role !== consumer.role || node.roleDef || consumer.roleDef || node.routes || consumer.routes
      || node.dispatch || consumer.dispatch || node.dynamic || consumer.dynamic || node.sends || consumer.sends) continue;
    diagnostics.push({
      severity: "advisory",
      code: "merge_candidate",
      nodeId: id,
      message: `nodes '${id}' and '${consumerId}' are consecutive single-path work assigned to the same role; merge them unless the intermediate output is independently valuable`,
    });
  }

  // 2. Route whitelist validation (B-class dynamic routing). Targets must be
  // existing downstream dependents so routing cannot create runtime topology or loops.
  for (const [id, node] of Object.entries(spec.nodes)) {
    if (node.routes && node.dispatch !== undefined) {
      errors.push(`node '${id}' cannot combine routes with dispatch`);
    }
    if (node.routes && (node.dynamic || node.sends)) {
      errors.push(`node '${id}' cannot combine routes with dynamic/sends`);
    }
    for (const [routeName, targets] of Object.entries(node.routes ?? {})) {
      if (!Array.isArray(targets)) {
        errors.push(`node '${id}' route '${routeName}' must be an array of target node ids`);
        continue;
      }
      for (const target of targets) {
        if (!spec.nodes[target]) {
          errors.push(`node '${id}' route '${routeName}' target '${target}' does not exist in spec.nodes`);
          continue;
        }
        if (!(spec.nodes[target].depends_on ?? []).includes(id)) {
          errors.push(`node '${id}' route '${routeName}' target '${target}' must depend_on '${id}' (routes are downstream-only)`);
        }
      }
    }
  }

  // 3. Check for circular deps (Kahn's algorithm would detect this; we do it eagerly
  //    for a clear error message before any execution).
  //    Build reverse graph: for each node, count distinct ancestors via DFS.
  //    If node appears in its own ancestor chain, it's circular.
  const ancestors = new Map<string, Set<string>>();
  function getAncestors(id: string, visited: Set<string>): Set<string> {
    if (ancestors.has(id)) return ancestors.get(id)!;
    if (visited.has(id)) {
      errors.push(`circular dependency detected involving '${id}'`);
      return new Set();
    }
    visited.add(id);
    const set = new Set<string>();
    for (const dep of (spec.nodes[id]?.depends_on ?? [])) {
      if (dep === id) {
        errors.push(`node '${id}' depends_on itself`);
        continue;
      }
      set.add(dep);
      for (const a of getAncestors(dep, visited)) set.add(a);
    }
    ancestors.set(id, set);
    return set;
  }
  for (const id of nodeIds) getAncestors(id, new Set());

  // Every declared dispatch stage is one dispatch level, including a spawned
  // result dispatcher. Bound chains to two; arbitrary graph growth is unsupported.
  const dispatchDepth = new Map<string, number>();
  const depthVisiting = new Set<string>();
  function getDispatchDepth(id: string): number {
    if (dispatchDepth.has(id)) return dispatchDepth.get(id)!;
    if (depthVisiting.has(id)) return 0; // cycle is reported separately above
    depthVisiting.add(id);
    const node = spec.nodes[id];
    const parentDepth = Math.max(0, ...(node?.depends_on ?? []).map(getDispatchDepth));
    const depth = parentDepth + (node?.dispatch !== undefined ? 1 : 0);
    depthVisiting.delete(id);
    dispatchDepth.set(id, depth);
    return depth;
  }
  for (const id of nodeIds) {
    const depth = getDispatchDepth(id);
    if (depth > HARD_MAX_DISPATCH_DEPTH) {
      errors.push(`node '${id}' reaches declared dispatch depth ${depth}, exceeding hard limit ${HARD_MAX_DISPATCH_DEPTH}`);
    }
  }

  // 4. Check that all nodes are reachable from root (nodes with no deps).
  //    Unreachable nodes have unsatisfiable deps (e.g. dep on a node that was
  //    removed or renamed). The planner (Kahn) would never schedule them, but
  //    we report the error early so the caller knows which node is orphaned.
  const inQueue = new Set<string>();
  const queue = nodeIds.filter(id => (spec.nodes[id].depends_on ?? []).length === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    inQueue.add(id);
    for (const [nid, node] of Object.entries(spec.nodes)) {
      if (inQueue.has(nid)) continue;
      if ((node.depends_on ?? []).every(d => inQueue.has(d))) {
        queue.push(nid);
      }
    }
  }
  for (const id of nodeIds) {
    if (!inQueue.has(id) && !errors.some(e => e.includes(id))) {
      const deps = (spec.nodes[id].depends_on ?? []).join(', ');
      errors.push(`node '${id}' is unreachable (deps [${deps}] cannot all be satisfied — missing node or circular)`);
    }
  }

  return { ok: errors.length === 0, errors, diagnostics };
}
