// SubagentsService — public subagent control surface for pi-roles.
//
// Exposes spawn (non-blocking, returns id) / getRecord / waitForResult / abort /
// hasRunning / listAgents. waitForResult is the piece gotgenes' public API lacked
// (its getRecord returned a promise-less snapshot, forcing callers to poll).
//
// spawn kicks off runSubagent async (fire-and-forget); the run settles the
// registry's completion promise. abort(id) cancels via a per-run AbortController
import * as fs from "node:fs";
import { hooks, type HookEvent, type HookHandler } from "../hooks";
// whose signal the runner observes (→ session.abort()). Status from runtime, not
// model text.

import { SubagentRegistry, type SubagentRecord } from "./registry";
import { runSubagent, type RunOutcome, type SubagentSession } from "./runner";
import { spawnRole, type SpawnDeps } from "./spawn";

export interface SubagentServiceParams {
  role?: string;
  task: string;
  parentSessionId?: string;
  tools?: string[];
  model?: any;       // resolved Model object (resolved by spawn-role-tool via ctx.modelRegistry)
  thinkingLevel?: unknown;
  resourceLoader?: unknown;
  /** Optional customTools registered directly on the child session. */
  customTools?: unknown[];
  maxTurns?: number;
  livenessMs?: number;
  /** P1-4: enable doom-loop detection (3 repeated identical assistant outputs). */
  doomLoop?: boolean;
  /** P2-7: telemetry callback for timing/status per subagent. */
  onTelemetry?: (event: { id: string; role?: string; event: string; durationMs?: number; turnCount?: number; status?: string }) => void;
  /** Called with the child session file + role name once the session is created
   *  (before prompt runs), so the agent_end fallback can recognize the session
   *  as a role session. */
  onSessionCreated?: (sessionFile: string, role: string) => void;
  /** P0-1: called when the background subagent completes, with the resolved
   *  record (status, result, reportPayload, turnCount). Fires asynchronously
   *  after the run settles — the spawn call has already returned. */
  onComplete?: (rec: { id: string; status: string; result?: string; error?: string; reportPayload?: { findings: string[]; artifacts: string[] }; turnCount: number; sessionFile?: string }) => void;
  /** Caller abort signal (e.g. parent turn ESC). */
  signal?: AbortSignal;
}

interface RunHandle {
  abortController: AbortController;
}

export class SubagentsService {
  private registry = new SubagentRegistry();
  private deps: SpawnDeps;
  private cwd: string;
  private agentDir: string;
  private handles = new Map<string, RunHandle>();
  /** P0-2 tree abort: parentSessionId → set of child agent IDs. */
  private children = new Map<string, Set<string>>();
  /** P1-3: max concurrent spawns (default 5). Gates runToCompletion entry. */
  private maxConcurrentSpawns: number;
  private runningSpawns = 0;
  private spawnQueue: Array<() => void> = [];
  /** P2-5: archived session files → timestamp (ms). */
  private archivedSessions = new Map<string, number>();
  private archiveSession: (sessionFile: string) => void;

  constructor(deps: SpawnDeps, env: { cwd: string; agentDir: string; archiveSession?: (sessionFile: string) => void }) {
    this.deps = deps;
    this.cwd = env.cwd;
    this.agentDir = env.agentDir;
    // P2-5: wrap archive to track timestamp.
    this.maxConcurrentSpawns = 5;
    const rawArchive = env.archiveSession ?? defaultArchiveSession;
    this.archiveSession = (path: string) => {
      const ts = Date.now();
      const archived = `${path}.archived.${ts}`;
      this.archivedSessions.set(archived, ts);
      rawArchive(path);
    };
    // Default: rename child .jsonl to .archived.<ts> so it leaves pi's dir scan
    // P2-5: archiveSession wrapper handles tracking.
  }

  /** Spawn a subagent run. Returns its id immediately; the run proceeds async. */
  spawn(params: SubagentServiceParams): string {
    const id = this.registry.register();
    const abortController = new AbortController();
    this.handles.set(id, { abortController });

    // Compose caller signal → our abort controller.
    if (params.signal) {
      if (params.signal.aborted) abortController.abort();
      else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    // Fire-and-forget the run; settle the registry when done.
    void this.runToCompletion(id, params, abortController.signal).catch((err) => {
      this.registry.reject(id, err instanceof Error ? err : new Error(String(err)));
    });

    // P0-2: track parent→child relationship for tree abort.
    if (params.parentSessionId) {
      let sib = this.children.get(params.parentSessionId);
      if (!sib) { sib = new Set(); this.children.set(params.parentSessionId, sib); }
      sib.add(id);
    }

    return id;
  }

  getRecord(id: string): SubagentRecord | undefined {
    return this.registry.getRecord(id);
  }

  waitForResult(id: string): Promise<SubagentRecord> {
    return this.registry.waitForResult(id);
  }

  /** Abort a running subagent AND all its descendants (P0-2 tree abort).
   *  Returns true if at least one agent was signalled to abort. */
  abort(id: string): boolean {
    let any = false;
    // Depth-limited tree walk — abort children recursively.
    const visited = new Set<string>();
    const walk = (nodeId: string) => {
      if (visited.has(nodeId)) return; // guard against cycles
      visited.add(nodeId);
      const h = this.handles.get(nodeId);
      if (h && !h.abortController.signal.aborted) {
        h.abortController.abort();
        any = true;
      }
      const kids = this.children.get(nodeId);
      if (kids) for (const c of kids) walk(c);
    };
    walk(id);
    return any;
  }

  /** Returns {abort} for the given agent id, or undefined if not found. */
  getAbortController(id: string): { abort: () => void } | undefined {
    const h = this.handles.get(id);
    return h ? { abort: () => h.abortController.abort() } : undefined;
  }

  hasRunning(): boolean {
    return this.registry.hasRunning();
  }

  listAgents(): string[] {
    return this.registry.listAgents();
  }

  /** P2-5: cleanup archived sessions older than retentionMs. Removes
   *  orphaned archived files whose parent was aborted before archive. */
  cleanup(retentionMs = 0): number {
    let removed = 0;
    const now = Date.now();
    for (const [path, ts] of this.archivedSessions) {
      if (now - ts > retentionMs) {
        try { fs.rmSync(path, { force: true }); removed++; }
        catch { /* best-effort */ }
        this.archivedSessions.delete(path);
      }
    }
    return removed;
  }

  /** P2-1: expose hook registration publicly so third-party plugins can
   *  register lifecycle handlers on subagent events. */
  on(event: HookEvent, handler: HookHandler): void {
    hooks.on(event, handler);
  }

  private async runToCompletion(
    id: string,
    params: SubagentServiceParams,
    signal: AbortSignal,
  ): Promise<void> {
    // P2-7: telemetry — start event.
    const t0 = Date.now();
    params.onTelemetry?.({ id, role: params.role, event: "subagent_start" });

    // P1-3: concurrency limiter — gate entry to prevent resource exhaustion.
    while (this.runningSpawns >= this.maxConcurrentSpawns) {
      await new Promise<void>(r => this.spawnQueue.push(r));
    }
    this.runningSpawns++;
    let outcome: RunOutcome | undefined;
    try {
    try { await hooks.emit("subagent_spawn:before", { id, role: params.role, task: params.task, parentSessionId: params.parentSessionId }); } catch {}

    const spawnResult = await spawnRole(this.deps, {
      cwd: this.cwd,
      agentDir: this.agentDir,
      parentSessionId: params.parentSessionId,
      task: params.task,
      tools: params.tools,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      resourceLoader: params.resourceLoader,
      customTools: params.customTools,
    });
    const session = spawnResult.session;
    // Notify caller of the child session file + role so the agent_end fallback
    // can recognize it as a role session (before prompt runs).
    if (spawnResult.sessionFile && params.onSessionCreated) {
      params.onSessionCreated(spawnResult.sessionFile, params.role ?? "default");
    }
    // Mark running now that the session exists.
    const state = this.registry.stateOf(id);
    state?.markRunning(Date.now());

    // Fire session_start so the pi-roles session_start handler runs and
    // additively adds report_role_result to the child's active tools. pi core's
    // createAgentSession does NOT call bindExtensions (only the interactive/print
    // modes do), so without this the handler never fires and the child cannot
    // call the output-contract tool. mode:'print' = non-interactive child.
    // Optional-chain guards minimal test fakes that don't provide it.
    await session.bindExtensions?.({ mode: "print" });

    try { await hooks.emit("subagent_spawn:after", { id, role: params.role, task: params.task, parentSessionId: params.parentSessionId, sessionFile: spawnResult.sessionFile }); } catch {}

    outcome = await runSubagent(session, params.task, {
      maxTurns: params.maxTurns,
      signal,
      livenessMs: params.livenessMs,
      doomLoop: params.doomLoop,
    });

    // Extract the report_role_result payload by scanning the child session's
    // messages for the tool call (not via cross-session reportState — the child
    // loads its own pi-roles instance with its own Map). This is the reliable
    // contract path: the structured {findings, artifacts} arguments the role
    // passed to report_role_result live in the assistant message's toolCall content.
    const reportPayload = extractReportPayload((session as any).messages);

    // B-cleanup: archive the child session file BEFORE resolving the registry,
    // so callers awaiting waitForResult see an already-archived session (no race
    // where the child .jsonl lingers in pi's session-tree scan after the result is
    // handed back). Best-effort: errors swallowed.
    if (spawnResult.sessionFile) {
      try { this.archiveSession(spawnResult.sessionFile); }
      catch { /* best-effort: cleanup failure does not affect the resolved run */ }
    }

    this.registry.resolve(id, (s) => {
      if (outcome!.status === "completed") {
        s.markCompleted(outcome!.finalText ?? "", Date.now());
      } else if (outcome!.status === "aborted") {
        s.markAborted(Date.now());
      } else {
        s.markError(outcome!.reason ?? "unknown error", Date.now());
      }
    }, outcome!.reason, outcome!.turnCount, spawnResult.sessionFile, reportPayload);

    // P0-1: notify caller when a background subagent completes.
    try { params.onComplete?.({
      id,
      status: outcome.status,
      result: outcome.finalText,
      error: outcome!.reason,
      reportPayload: reportPayload ?? (outcome!.finalText ? { findings: [outcome!.finalText], artifacts: [] } : undefined),
      turnCount: outcome!.turnCount,
      sessionFile: spawnResult.sessionFile,
    }); } catch { /* best-effort */ }

    // P0-3: lifecycle hook — complete / stop / error.
    try {
      const hookEvent = outcome!.status === "completed" ? "subagent_complete"
        : outcome!.status === "aborted" ? "subagent_stop" : "subagent_error";
      await hooks.emit(hookEvent, {
        id, role: params.role, task: params.task, parentSessionId: params.parentSessionId,
        status: outcome!.status, error: outcome!.reason, sessionFile: spawnResult.sessionFile, turnCount: outcome!.turnCount,
      });
    } catch { /* best-effort */ }

    } finally {
      // P2-7: telemetry — end event.
      params.onTelemetry?.({ id, role: params.role, event: "subagent_end", durationMs: Date.now() - t0, turnCount: outcome?.turnCount, status: outcome?.status });
      // P1-3: release concurrency slot, wake next queued spawn.
      this.runningSpawns--;
      this.spawnQueue.shift()?.();
    }
  }
}

// Default archive: rename <file>.jsonl → <file>.jsonl.archived.<ts>.
// pi's session-tree scan filters `f.endsWith(".jsonl")`, so the renamed file
// disappears from the tree while its content is preserved for audit.
// ponytail: rename not unlink — keeps the transcript for debugging.
function defaultArchiveSession(sessionFile: string): void {
  fs.renameSync(sessionFile, `${sessionFile}.archived.${Date.now()}`);
}

// Scan child session messages for the report_role_result tool call and extract
// its {findings, artifacts} arguments. Returns undefined if the role never called it.
function extractReportPayload(messages: any[] | undefined): { findings: string[]; artifacts: string[] } | undefined {
  if (!messages) return undefined;
  for (const m of messages) {
    if (m?.role !== "assistant") continue;
    const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall" && c?.name === "report_role_result");
    for (const c of calls) {
      const args = c.arguments;
      if (args && Array.isArray(args.findings) && Array.isArray(args.artifacts)) {
        return { findings: args.findings, artifacts: args.artifacts };
      }
    }
  }
  return undefined;
}
