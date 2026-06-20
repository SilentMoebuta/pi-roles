// Lifecycle hooks (P0-3) — minimal event system for subagent lifecycle.
// Registers async handlers that fire sequentially at key points: spawn,
// completion, stop, error. Hook errors are swallowed (never crash the subagent).
// Mirrors Claude Code's hook surface (30 hooks → we start with 5).

export type HookEvent =
  | "subagent_spawn:before"   // before runToCompletion starts
  | "subagent_spawn:after"    // after spawnRole + bindExtensions, before prompt
  | "subagent_complete"       // runToCompletion finished successfully
  | "subagent_stop"           // run was aborted
  | "subagent_error"          // run threw an error
  // P2-1: tool-level lifecycle hooks (emitted by deny-rules extension)
  | "tool_use:before"         // before a tool executes (toolName, input)
  | "tool_use:after";         // after a tool executes (toolName, input, isError)

export interface HookContext {
  id?: string;
  role?: string;
  task?: string;
  parentSessionId?: string;
  status?: string;        // "completed" | "aborted" | "error" (present on complete/stop/error)
  error?: string;          // present on subagent_error
  sessionFile?: string;
  turnCount?: number;
  // P2-1: tool-level hook fields (present on tool_use:before/after)
  toolName?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

export type HookHandler = (ctx: HookContext) => Promise<void>;

class HookRegistry {
  private handlers = new Map<HookEvent, HookHandler[]>();

  /** Register an async handler for a lifecycle event. */
  on(event: HookEvent, handler: HookHandler): void {
    let list = this.handlers.get(event);
    if (!list) { list = []; this.handlers.set(event, list); }
    list.push(handler);
  }

  /** Fire all handlers for an event sequentially. Errors are caught + logged, not propagated. */
  async emit(event: HookEvent, ctx: HookContext): Promise<void> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;
    for (const h of list) {
      try { await h({ ...ctx }); }
      catch (e) { console.error(`[pi-roles:hooks] ${event} handler error:`, e); }
    }
  }

  /** Clear all registered handlers (for test isolation). */
  clear(): void {
    this.handlers.clear();
  }
}

export const hooks = new HookRegistry();
