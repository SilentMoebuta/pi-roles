import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Preset, PresetFrontmatter, PresetSourceType, PresetTaskType } from "./types";

const LEGAL_TASK_TYPES: PresetTaskType[] = ["coding", "research", "pm", "review", "debug"];
const LEGAL_SOURCES: PresetSourceType[] = ["builtin", "user", "agent"];

function isLegalTaskType(s: string): s is PresetTaskType {
	return (LEGAL_TASK_TYPES as string[]).includes(s);
}
function isLegalSource(s: string): s is PresetSourceType {
	return (LEGAL_SOURCES as string[]).includes(s);
}

function loadPresetFile(filePath: string): Preset | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const { frontmatter } = parseFrontmatter<PresetFrontmatter>(raw);
		const name = (frontmatter.name ?? "").trim();
		const description = (frontmatter.description ?? "").trim();
		if (!name || !description) return null; // graceful skip
		const taskTypeRaw = frontmatter.task_type ?? "";
		if (!isLegalTaskType(taskTypeRaw)) return null; // skip malformed
		const sourceRaw = frontmatter.source ?? "user";
		return {
			name,
			description,
			taskType: taskTypeRaw,
			allowedRoles: Array.isArray(frontmatter.allowed_roles)
				? frontmatter.allowed_roles.map(String)
				: [],
			allowedTools: Array.isArray(frontmatter.allowed_tools)
				? frontmatter.allowed_tools.map(String)
				: [],
			source: (isLegalSource(sourceRaw) ? sourceRaw : "user") as PresetSourceType,
			version: frontmatter.version ?? "1.0",
			author: frontmatter.author ?? "",
			filePath,
		};
	} catch {
		return null; // graceful skip on parse error
	}
}

function scanDir(dir: string): Preset[] {
	if (!dir || !fs.existsSync(dir)) return [];
	const out: Preset[] = [];
	// ponytail:极简版不处理 .gitignore, 仅扫顶层 *.md (preset 库平铺, 不深递归)
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".md")) continue;
		const p = loadPresetFile(path.join(dir, e.name));
		if (p) out.push(p);
	}
	return out;
}

/**
 * Load presets from builtin dir (pi-roles repo) + user dir + project dir.
 * Priority: builtin < user < project (project overrides user overrides builtin
 * on name collision, 抄 Factory "project 覆盖 personal").
 * 极简版 caveat: 不处理 .gitignore; preset 库平铺单层不深递归。后续若有需求再补。
 */
export function loadPresets(builtinDir: string, userDir: string, projectDir: string): { presets: Preset[] } {
	const byName = new Map<string, Preset>();
	for (const p of scanDir(builtinDir)) byName.set(p.name, p);
	for (const p of scanDir(userDir)) byName.set(p.name, p);
	for (const p of scanDir(projectDir)) byName.set(p.name, p);
	return { presets: Array.from(byName.values()) };
}
