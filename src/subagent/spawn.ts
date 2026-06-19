// spawnRole — builds a child subagent session with the parentSession header set
// and the role tool allowlist applied.
//
// pi primitive basis (research note Appendix A.6/A.7): createAgentSession accepts
// `sessionManager?` (default SessionManager.create(cwd)) and `tools?` (allowlist)
// and `model?` (Model<any> object). SessionManager.create(cwd) then
// newSession({parentSession}) sets the header that the 3 isSubagentSession
// guards read (pi-goal/pi-auto-fix-loop/pi-plan-execute-gate). This is the same
// native path gotgenes uses — no fork, no assumption.
//
// Injectable deps keep the orchestration logic testable without a real pi runtime;
// service.ts wires the real createAgentSession + SessionManager.

import type { SubagentSession } from "./runner";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

export interface SessionManagerLike {
  newSession(options?: { parentSession?: string }): unknown;
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

export interface CreateSessionOpts {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  tools?: string[];
  model?: Model<any>;
  thinkingLevel?: unknown;
  /** Optional resourceLoader: when provided, createAgentSession uses it instead of
   *  building its own default (sdk.js:66). Used by spawn_role to inject a
   *  role-specific skillsOverride (Phase 2 skill isolation). */
  resourceLoader?: unknown;
}

export interface SpawnDeps {
  makeSessionManager: (cwd: string) => SessionManager;
  createSession: (opts: CreateSessionOpts) => Promise<{ session: SubagentSession }>;
}

export interface SpawnParams {
  cwd: string;
  agentDir: string;
  /** Parent's session id. When set, newSession({parentSession}) marks this child as a subagent. */
  parentSessionId?: string;
  task: string;
  /** Role tool allowlist (string[] form). undefined = inherit pi default tools. */
  tools?: string[];
  /** Resolved Model object (caller resolves frontmatter id via ctx.modelRegistry). */
  model?: any;
  thinkingLevel?: unknown;
  /** Optional resourceLoader with role-specific skillsOverride (Phase 2). */
  resourceLoader?: unknown;
}

export interface SpawnResult {
  session: SubagentSession;
  sessionId: string;
  sessionFile?: string;
  parentSessionSet: boolean;
}

export async function spawnRole(deps: SpawnDeps, params: SpawnParams): Promise<SpawnResult> {
  const sessionManager = deps.makeSessionManager(params.cwd);
  let parentSessionSet = false;
  if (params.parentSessionId) {
    sessionManager.newSession({ parentSession: params.parentSessionId });
    parentSessionSet = true;
  } else {
    // Still start a fresh session leaf so getSessionId/File resolve for the child.
    sessionManager.newSession({});
  }

  const { session } = await deps.createSession({
    cwd: params.cwd,
    agentDir: params.agentDir,
    sessionManager,
    tools: params.tools,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    resourceLoader: params.resourceLoader,
  });

  return {
    session,
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile() ?? undefined,
    parentSessionSet,
  };
}
