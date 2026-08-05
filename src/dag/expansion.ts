import { sendToTask, type Send } from "./send";
import type { DAGNode, DAGSpec, GeneratedNodeRecord } from "./types";

export function generatedNodeId(parentId: string, key: string): string {
  return `${parentId}::${key.trim()}`;
}

/** Expand a declared dispatch into ordinary scheduler-visible nodes. The
 * dispatching node becomes a join over its generated children, so generated
 * work participates in concurrency, checkpoints, progress, and resume. */
export function expandDispatchNode(
  spec: DAGSpec,
  parentId: string,
  sends: Send[],
  existing: Record<string, GeneratedNodeRecord> = {},
): { spec: DAGSpec; generatedNodes: Record<string, GeneratedNodeRecord> } {
  const parent = spec.nodes[parentId];
  if (!parent) throw new Error(`cannot expand unknown dispatch node '${parentId}'`);

  const generatedNodes = { ...existing };
  const ids = sends.map((send) => generatedNodeId(parentId, send.key!));
  for (let index = 0; index < sends.length; index++) {
    const id = ids[index];
    if (spec.nodes[id] || generatedNodes[id]) {
      throw new Error(`generated node id '${id}' collides with an existing node`);
    }
  }

  const originalDependencies = [...(parent.depends_on ?? [])];
  const nodes: Record<string, DAGNode> = { ...spec.nodes };
  for (const dependencyId of originalDependencies) {
    const dependency = nodes[dependencyId];
    if (!dependency?.consumers?.includes(parentId)) continue;
    nodes[dependencyId] = {
      ...dependency,
      consumers: [...dependency.consumers, ...ids],
    };
  }

  const { dynamic: _dynamic, sends: _sends, ...join } = parent;
  nodes[parentId] = { ...join, depends_on: [...originalDependencies, ...ids] };
  for (let index = 0; index < sends.length; index++) {
    const send = sends[index];
    const id = ids[index];
    nodes[id] = {
      role: send.role,
      task: sendToTask(send),
      expected_output: send.expected_output,
      consumers: send.consumers ? [parentId] : undefined,
      depends_on: originalDependencies.length > 0 ? originalDependencies : undefined,
      timeout_ms: parent.timeout_ms,
      priority: parent.priority,
      write_scope: parent.write_scope ? [...parent.write_scope] : undefined,
    };
    generatedNodes[id] = { id, key: send.key!.trim(), parentId };
  }
  return { spec: { ...spec, nodes }, generatedNodes };
}

export function generatedChildren(
  generatedNodes: Readonly<Record<string, GeneratedNodeRecord>>,
  parentId: string,
): string[] {
  return Object.values(generatedNodes).filter((node) => node.parentId === parentId).map((node) => node.id);
}
