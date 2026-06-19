// agent_end fallback — contract reliability via MECHANISM, not model compliance.
//
// When a role subagent finishes WITHOUT calling report_role_result (the model
// ignored the prompt instruction, or errored), the system constructs a fallback
// payload from the last assistant message so spawn_role still receives a
// structured {findings, artifacts} result. The contract is honored by the
// runtime, not by the model choosing to call a tool.
//
// This handler runs on EVERY agent_end (main + role sessions). It only acts on
// role sessions (activeRole has an entry for the session file) that haven't
// already reported (no payload, not in reported set).

import type { ReportState, ReportPayload } from "../report-tool";

export interface FallbackDeps {
  payloads: Map<string, ReportPayload>;
  reported: Set<string>;
  activeRole: Map<string, string>;
  getSessionFile: (ctx: unknown) => string | undefined;
}

interface AgentEndEventLike {
  type: "agent_end";
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
}

// Extract the concatenated text of the last assistant message (text blocks only).
function lastAssistantText(messages: AgentEndEventLike["messages"]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      return m.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("");
    }
  }
  return undefined;
}

export function makeAgentEndFallback(deps: FallbackDeps) {
  return function (event: AgentEndEventLike, ctx: unknown): void {
    const sessionFile = deps.getSessionFile(ctx);
    // DIAGNOSTIC: stash what the fallback saw into a side channel so spawn_role
    // can report it (payloads map under a reserved "__diag__" key).
    const sf = sessionFile ?? "<undefined>";
    const hasActive = deps.activeRole.has(sf);
    const hadPayload = deps.payloads.has(sf);
    const hadReported = deps.reported.has(sf);
    deps.payloads.set("__diag__", {
      findings: [`agent_end fired: sessionFile=${sf} hasActive=${hasActive} hadPayload=${hadPayload} hadReported=${hadReported} activeRoleKeys=[${[...deps.activeRole.keys()].join(",")}] msgCount=${event.messages?.length}`],
      artifacts: [],
    });
    if (!sessionFile) return; // cannot key the payload

    // Only role sessions (main agent has no activeRole entry).
    if (!deps.activeRole.has(sessionFile)) return;

    // If the role already reported (payload present or session in reported set),
    // do not overwrite the real structured payload.
    if (deps.payloads.has(sessionFile) || deps.reported.has(sessionFile)) return;

    const text = lastAssistantText(event.messages);
    const fallback: ReportPayload = {
      findings: text ? [text] : [],
      artifacts: [],
    };
    deps.payloads.set(sessionFile, fallback);
    deps.reported.add(sessionFile);
  };
}
