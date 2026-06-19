import * as fs from "node:fs";

export interface RoleDef {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  skills: string[];
  maxTurns: number;
  outputSchema?: import("./contract").ReportSchema;
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
  return { name, description, prompt, tools, skills, maxTurns };
}
