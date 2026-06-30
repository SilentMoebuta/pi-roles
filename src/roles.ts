import * as fs from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
  /** P2-2: tools denied to this role. Stripped from childTools before spawn. */
  disallowedTools?: string[];
}

export const DEFAULT_MAX_TURNS = 25;

export function parseRoleFrontmatter(file: string): RoleDef {
  const raw = fs.readFileSync(file, "utf-8");
  // B4: 统一用 pi-core parseFrontmatter 替换手写正则(技术债 Phase2a approver 提)。保留 object-form tools 特殊提取(P1-1)。
  const { frontmatter: fmObj, body } = parseFrontmatter<Record<string, unknown>>(raw);
  const fm = fmObj as Record<string, string>;
  const prompt = body.trim();
  const get = (key: string): string | undefined => {
    const v = fm[key];
    return typeof v === "string" ? v.trim() : (v != null ? String(v).trim() : undefined);
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
  // B4: fm 现在是对象(parseFrontmatter 返回)非字符串, object-form 先试 parseFrontmatter
  // 解析为对象, 不行则从 raw 原文提取 fallback。
  const toolDenyRules: Record<string, string[]> = {};
  const disallowedTools = parseList(get("disallowedTools"));
  const toolsVal = fmObj["tools"];
  if (tools.length === 0 && typeof toolsVal === "object" && toolsVal !== null && !Array.isArray(toolsVal)) {
    for (const [toolName, rule] of Object.entries(toolsVal as Record<string, any>)) {
      tools.push(toolName);
      if (rule && Array.isArray(rule.deny)) toolDenyRules[toolName] = rule.deny.map(String);
    }
  } else if (tools.length === 0) {
    const fmRawMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    const fmText = fmRawMatch ? fmRawMatch[1] : "";
    if (fmText.includes("tools:")) {
      const toolsBlock = (fmText.match(/^tools:\s*\n([\s\S]*?)(?=^\w+:|$)/m) ?? [])[1];
      if (toolsBlock) {
        const entries = toolsBlock.match(/^(\w+):\s*\{([^}]+)\}/gm);
        if (entries) {
          for (const entry of entries) {
            const em = entry.match(/^(\w+):\s*\{([^}]+)\}/);
            if (!em) continue;
            const toolName = em[1];
            tools.push(toolName);
            const denyMatch = em[2].match(/deny:\s*\[([^\]]*)\]/);
            if (denyMatch) toolDenyRules[toolName] = parseList(denyMatch[1]);
          }
        }
      }
    }
  }
  const def: RoleDef = { name, description, prompt, tools, skills, maxTurns, canSpawn: false, teammates: [], model, thinkingLevel };
  if (Object.keys(toolDenyRules).length > 0) def.toolDenyRules = toolDenyRules;
  if (disallowedTools.length > 0) def.disallowedTools = disallowedTools;
  return def;
}
