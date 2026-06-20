/**
 * P1-1: Runtime enforcement of per-key glob deny rules (toolDenyRules).
 * P2-1: Tool-level lifecycle hooks (tool_use:before / tool_use:after).
 *
 * Uses pi core's existing `beforeToolCall` → `extensionRunner.emitToolCall` →
 * `ext.handlers.get("tool_call")` pipeline. A `tool_call` handler returning
 * `{ block: true, reason }` causes pi core to skip execution and return an error
 * tool result (confirmed: agent-loop.js line 386).
 *
 * No pi core changes — we construct a plain Extension object with a pre-populated
 * `handlers` Map and inject it via `DefaultResourceLoader.extensionsOverride`.
 */

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { hooks } from "../hooks";

/** Glob pattern → boolean. Supports `*` wildcard (matches any chars except none). */
export function globMatch(pattern: string, text: string): boolean {
  // ponytail: convert glob to regex — escape everything except *
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
  );
  return regex.test(text);
}

/** Extract the matchable command/string from a tool_call event input.
 *  Different tools put the user-controlled text in different fields. */
export function extractCommand(toolName: string, input: Record<string, unknown>): string {
  // bash: input.command; read/write/edit: input.path or input.file_path;
  // grep: input.pattern; generic: fall back to JSON of input
  // ponytail: KNOWN BYPASS — raw-string matching on input.command. A `rm *` deny
  // rule does NOT match `bash -c 'rm -rf /'` (command doesn't start with 'rm').
  // OpenCode normalizes bash via tree-sitter; we don't (no shipped role uses
  // deny-rules today — Tier 4 inert). A partial normalizer (strip bash -c / quotes)
  // would create FALSE CONFIDENCE (nested wrappers like `env bash -c`, `sh -c
  // 'bash -c ...'`, eval still evade) — worse than documenting. Lock-in test
  // in __tests__/deny-rules.test.ts (KNOWN BYPASS). Upgrade path: tree-sitter
  // bash parsing, gated on a role opting into deny-rules (Tier 4).
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") return input.path;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  return JSON.stringify(input);
}

/** Deny rules: { bash: ["rm *", "git push *"], write: ["*.env"] } */
export type DenyRules = Record<string, string[]>;

/** G-PERM-1: bash deny-rules are bypassable via shell wrappers (raw-string
 *  matching: `bash -c 'rm -rf /'` evades `rm *`). No shipped role uses deny-rules
 *  today (Tier 4 inert), so a user opting in gets SILENT FALSE PROTECTION.
 *  Approver decision (2026-06-20): WARN-ONLY (not tree-sitter-bash — inert feature
 *  + a partial normalizer is worse + zero new deps). This returns the loud warning
 *  text for bash rules, or null when there are none (no false alarm). */
export function bashBypassWarning(rules: DenyRules): string | null {
  const patterns = rules["bash"];
  if (!patterns || patterns.length === 0) return null;
  return (
    `[pi-roles:deny-rules] WARNING: bash deny-rules ${JSON.stringify(patterns)} are NOT a security boundary — ` +
    `shell wrappers evade raw-string matching (e.g. \`bash -c 'rm -rf /'\` bypasses \`rm *\`). ` +
    `Deny-rules are best-effort; do not rely on them for safety. (G-PERM-1, documented T3-6 limitation)`
  );
}

// G-PERM-1: warn once per unique bash-rules-set per process (a role spawned N
// times should not spam stderr, but the first application must be LOUD).
const _warnedBashRuleSets = new Set<string>();

/** A minimal Extension object compatible with pi core's ExtensionRunner. */
export interface MinimalExtension {
  path: string;
  resolvedPath: string;
  sourceInfo: ReturnType<typeof createSyntheticSourceInfo>;
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<any>>>;
  tools: Map<string, unknown>;
  messageRenderers: Map<string, unknown>;
  commands: Map<string, unknown>;
  flags: Map<string, unknown>;
  shortcuts: Map<string, unknown>;
}

/**
 * Build a deny-rules extension that blocks tool calls matching `rules`.
 * Also emits P2-1 tool_use:before / tool_use:after hook events.
 */
export function createDenyRulesExtension(rules: DenyRules): MinimalExtension {
  // G-PERM-1: convert silent false-confidence → INFORMED at configuration time
  // (spawn = when the bypass-vulnerable rules are applied). Loud stderr, once.
  const _bashWarn = bashBypassWarning(rules);
  if (_bashWarn) {
    const _key = JSON.stringify(rules["bash"]);
    if (!_warnedBashRuleSets.has(_key)) { _warnedBashRuleSets.add(_key); console.error(_bashWarn); }
  }
  const toolCallHandler = async (event: { toolName: string; input: Record<string, unknown> }, _ctx: unknown) => {
    // P2-1: emit tool_use:before hook
    try {
      await hooks.emit("tool_use:before", {
        toolName: event.toolName,
        input: event.input,
      });
    } catch { /* hook errors are isolated */ }

    // P1-1: check deny rules
    const patterns = rules[event.toolName];
    if (patterns && patterns.length > 0) {
      const command = extractCommand(event.toolName, event.input);
      for (const pattern of patterns) {
        if (globMatch(pattern, command)) {
          return {
            block: true,
            reason: `Denied by role policy: ${event.toolName} matching "${pattern}"`,
          };
        }
      }
    }
    return undefined; // allow — let the tool execute
  };

  const toolResultHandler = async (event: { toolName: string; input: Record<string, unknown>; isError: boolean }, _ctx: unknown) => {
    // P2-1: emit tool_use:after hook
    try {
      await hooks.emit("tool_use:after", {
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
      });
    } catch { /* hook errors are isolated */ }
    return undefined;
  };

  return {
    path: "<pi-roles:deny-rules>",
    resolvedPath: "<pi-roles:deny-rules>",
    sourceInfo: createSyntheticSourceInfo("<pi-roles:deny-rules>", { source: "sdk" }),
    handlers: new Map([
      ["tool_call", [toolCallHandler]],
      ["tool_result", [toolResultHandler]],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

// ponytail: self-check — glob matching correctness
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  };
  assert(globMatch("rm *", "rm -rf /"), "rm * should match rm -rf /");
  assert(!globMatch("rm *", "npm test"), "rm * should not match npm test");
  assert(globMatch("*.env", ".env"), "*.env should match .env");
  assert(globMatch("*.env", "prod.env"), "*.env should match prod.env");
  assert(!globMatch("*.env", "config.json"), "*.env should not match config.json");
  assert(globMatch("git push *", "git push origin main"), "git push * should match");
  assert(extractCommand("bash", { command: "ls -la" }) === "ls -la", "extract bash command");
  assert(extractCommand("write", { path: "/foo/.env" }) === "/foo/.env", "extract write path");
  console.log("All deny-rules self-checks passed.");
}
