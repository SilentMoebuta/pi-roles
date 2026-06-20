import * as fs from "node:fs";

export interface RoleDef {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  skills: string[];
  maxTurns: number;
  /** Can this role spawn further subagents? Default false (anti-cascade).
   *  Reserved for orchestrator/lead roles (team future). Phase 1: only main agent spawns. */
  canSpawn: boolean;
  /** Roles this role may spawn (team future, reserved). Phase 1: unused. */
  teammates: string[];
  /** Model id for this role's subagent (e.g. 'deepseek-v4-flash'). Default: inherit main session. */
  model?: string;
  /** Thinking level for this role (e.g. 'xhigh'). Default: inherit. */
  thinkingLevel?: string;
  outputSchema?: import("./contract").ReportSchema;
  /** P1-1: per-tool deny patterns (glob-like). Key = tool name, value = deny patterns.
   *  Populated when role frontmatter uses object-form tools: field. */
  toolDenyRules?: Record<string, string[]>;
}

export const DEFAULT_MAX_TURNS = 25;

export function parseRoleFrontmatter(file: string): RoleDef {
  const raw = fs.readFileSync(file, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`role file missing frontmatter: ${file}`);
  const fm = m[1];
  const prompt = m[2].trim();
  const get = (key: string): string | undefined => {
    const line = fm.split("\n").find((l: string) => l.startsWith(key + ":"));
    return line?.slice((key + ":").length).trim();
  };
  const parseList = (v: string | undefined): string[] => {
    if (!v) return [];
    return v.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
  };
  const tools = parseList(get("tools"));
  const skills = parseList(get("skills"));
  const maxTurns = get("maxTurns") ? parseInt(get("maxTurns")!, 10) : DEFAULT_MAX_TURNS;
  const name = get("name") ?? "";
  const description = get("description") ?? "";
  const model = get("model");
  const thinkingLevel = get("thinkingLevel");
  // P1-1: object-form tools → extract tool names + deny rules.
  const toolDenyRules: Record<string, string[]> = {};
  if (tools.length === 0 && fm.includes("tools:")) {
    // Try object form parsing — find the tools: block
    const toolsBlock = (fm.match(/^tools:\s*\n([\s\S]*?)(?=^\w+:|\$)/m)??[])[1];
    if (toolsBlock) {
      // Parse YAML-like: Bash: {allow: [...], deny: [...]}
      const entries = toolsBlock.match(/^(\w+):\s*\{([^}]+)\}/gm);
      if (entries) {
        for (const entry of entries) {
          const m = entry.match(/^(\w+):\s*\{([^}]+)\}/);
          if (!m) continue;
          const toolName = m[1];
          tools.push(toolName);
          const body = m[2];
          const denyMatch = body.match(/deny:\s*\[([^\]]*)\]/);
          if (denyMatch) {
            toolDenyRules[toolName] = parseList(denyMatch[1]);
          }
        }
      }
    }
  }
  const def: RoleDef = { name, description, prompt, tools, skills, maxTurns, canSpawn: false, teammates: [], model, thinkingLevel };
  if (Object.keys(toolDenyRules).length > 0) def.toolDenyRules = toolDenyRules;
  return def;
}
