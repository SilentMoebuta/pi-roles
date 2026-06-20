// SubagentsService — public subagent control surface for pi-roles.
//
// Exposes spawn (non-blocking, returns id) / getRecord / waitForResult / abort /
// hasRunning / listAgents. waitForResult is the piece gotgenes' public API lacked
// (its getRecord returned a promise-less snapshot, forcing callers to poll).
//
// spawn kicks off runSubagent async (fire-and-forget); the run settles the
// registry's completion promise. abort(id) cancels via a per-run AbortController
import * as fs from "node:fs";
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
  maxTurns?: number;
  livenessMs?: number;
  /** Called with the child session file + role name once the session is created
   *  (before prompt runs), so the agent_end fallback can recognize the session
   *  as a role session. */
  onSessionCreated?: (sessionFile: string, role: string) => void;
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
  private archiveSession: (sessionFile: string) => void;

  constructor(deps: SpawnDeps, env: { cwd: string; agentDir: string; archiveSession?: (sessionFile: string) => void }) {
    this.deps = deps;
    this.cwd = env.cwd;
    this.agentDir = env.agentDir;
    // Default: rename child .jsonl to .archived.<ts> so it leaves pi's dir scan
    // (pi only scans *.jsonl) while preserving the transcript for audit.
    this.archiveSession = env.archiveSession ?? defaultArchiveSession;
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

    return id;
  }

  getRecord(id: string): SubagentRecord | undefined {
    return this.registry.getRecord(id);
  }

  waitForResult(id: string): Promise<SubagentRecord> {
    return this.registry.waitForResult(id);
  }

  /** Abort a running subagent. Returns true if a run was signalled to abort. */
  abort(id: string): boolean {
    const h = this.handles.get(id);
    if (!h) return false;
    if (h.abortController.signal.aborted) return false;
    h.abortController.abort();
    return true;
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

  private async runToCompletion(
    id: string,
    params: SubagentServiceParams,
    signal: AbortSignal,
  ): Promise<void> {
    const spawnResult = await spawnRole(this.deps, {
      cwd: this.cwd,
      agentDir: this.agentDir,
      parentSessionId: params.parentSessionId,
      task: params.task,
      tools: params.tools,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      resourceLoader: params.resourceLoader,
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

    const outcome: RunOutcome = await runSubagent(session, params.task, {
      maxTurns: params.maxTurns,
      signal,
      livenessMs: params.livenessMs,
    });

    // Extract the report_role_result payload by scanning the child session's
    // messages for the tool call (not via cross-session reportState — the child
    // loads its own pi-roles instance with its own Map). This is the reliable
    // contract path: the structured {findings, artifacts} arguments the role
    // passed to report_role_result live in the assistant message's toolCall content.
    const reportPayload = extractReportPayload((session as any).messages);

    this.registry.resolve(id, (s) => {
      if (outcome.status === "completed") {
        s.markCompleted(outcome.finalText ?? "", Date.now());
      } else if (outcome.status === "aborted") {
        s.markAborted(Date.now());
      } else {
        s.markError(outcome.reason ?? "unknown error", Date.now());
      }
    }, outcome.reason, outcome.turnCount, spawnResult.sessionFile, reportPayload);

    // B-cleanup: archive the child session file so it leaves pi's session-tree
    // dir scan (pi only scans *.jsonl). Transcript preserved for audit.
    // Best-effort: errors swallowed (run already resolved successfully).
    if (spawnResult.sessionFile) {
      try { this.archiveSession(spawnResult.sessionFile); }
      catch { /* best-effort: cleanup failure does not affect the resolved run */ }
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
