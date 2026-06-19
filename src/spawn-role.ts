import { isDepthExceeded, nextDepth, shouldAbortForStep, isLivenessTimeout } from "./control-plane";
import type { RoleDef } from "./roles";

export interface SpawnContext {
  getSubagentsService: () => unknown; // SubagentsService | undefined at runtime
  currentDepth: number;
  maxDepth: number;
  livenessTimeoutMs: number;
  now?: () => number;
  pollIntervalMs?: number;
  roleRegistry: Map<string, RoleDef>;
  /** Caller's abort signal (e.g. parent turn ESC). On abort the spawned child is aborted and the loop breaks. */
  signal?: AbortSignal;
  /** test hook: mutate the record before the first poll evaluation */
  onFirstPoll?: (id: string) => void;
}

export interface SpawnResult { error?: string; agentId?: string; }

interface SubagentRecordLike {
  status: string; toolUses: number; startedAt: number; completedAt?: number;
}
interface SubagentsServiceLike {
  spawn(type: string, prompt: string, opts?: { maxTurns?: number; foreground?: boolean }): string;
  getRecord(id: string): SubagentRecordLike | undefined;
  abort(id: string): boolean;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "aborted" || status === "stopped" || status === "error";
}

export async function spawnRole(roleName: string, task: string, sctx: SpawnContext): Promise<SpawnResult> {
  const role = sctx.roleRegistry.get(roleName);
  if (!role) return { error: `unknown role: ${roleName}` };
  const depth = nextDepth(sctx.currentDepth);
  if (isDepthExceeded(depth, sctx.maxDepth)) return { error: `depth limit exceeded (${depth} > ${sctx.maxDepth})` };
  const service = sctx.getSubagentsService() as SubagentsServiceLike | undefined;
  if (!service) return { error: "subagent service unavailable (is @gotgenes/pi-subagents installed?)" };

  const id = service.spawn(role.name, task, { maxTurns: role.maxTurns, foreground: false });
  const now = sctx.now ?? Date.now;
  const pollMs = sctx.pollIntervalMs ?? 1000;
  let firstPoll = true;

  // Watcher: poll until terminal, enforcing step limit + liveness timeout.
  // In tests pollIntervalMs=0 and onFirstPoll drives state synchronously.
  while (true) {
    if (sctx.signal?.aborted) { service.abort(id); return { error: `aborted by caller signal: ${id}` }; }
    const rec = service.getRecord(id);
    if (firstPoll) { sctx.onFirstPoll?.(id); firstPoll = false; }
    const recAfter = service.getRecord(id) ?? rec;
    if (!recAfter) return { error: `spawned agent record vanished: ${id}` };
    if (isTerminal(recAfter.status)) return { agentId: id };
    if (shouldAbortForStep(recAfter.toolUses, role.maxTurns)) {
      service.abort(id);
      return { error: `step limit reached (${recAfter.toolUses} >= ${role.maxTurns}); aborted ${id}` };
    }
    if (isLivenessTimeout(recAfter.startedAt, sctx.livenessTimeoutMs, now())) {
      service.abort(id);
      return { error: `liveness timeout exceeded (${sctx.livenessTimeoutMs}ms); aborted ${id}` };
    }
    if (pollMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    } else {
      // pollIntervalMs<=0 with a still-running, non-terminal agent: refuse to
      // pretend success (caller would believe the role finished). Tests that
      // drive terminal state via onFirstPoll return before reaching here.
      return { error: "non-positive pollIntervalMs not allowed for running agents" };
    }
  }
}
