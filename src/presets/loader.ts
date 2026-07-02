import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Preset, PresetFrontmatter, PresetSourceType, PresetTaskType, PresetLifecycle } from "./types";

const LEGAL_TASK_TYPES: PresetTaskType[] = ["coding", "research", "pm", "review", "debug"];
const LEGAL_SOURCES: PresetSourceType[] = ["builtin", "user", "agent"];
const LEGAL_LIFECYCLES: PresetLifecycle[] = ["stable", "provisional"];
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"]; // B1: 对齐 pi-core loadSkillsFromDir

function isLegalTaskType(s: string): s is PresetTaskType {
	return (LEGAL_TASK_TYPES as string[]).includes(s);
}
function isLegalSource(s: string): s is PresetSourceType {
	return (LEGAL_SOURCES as string[]).includes(s);
}
function isLegalLifecycle(s: string): s is PresetLifecycle {
	return (LEGAL_LIFECYCLES as string[]).includes(s);
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
		const lifecycleRaw = frontmatter.lifecycle ?? "stable";
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
			lifecycle: isLegalLifecycle(lifecycleRaw) ? lifecycleRaw : "stable",
			validation: typeof frontmatter.validation === "string" ? frontmatter.validation : "",
		};
	} catch {
		return null; // graceful skip on parse error
	}
}

function scanDir(dir: string): Preset[] {
	if (!dir || !fs.existsSync(dir)) return [];
	const out: Preset[] = [];
	// B1: 处理 .gitignore (对齐 pi-core loadSkillsFromDir, 抄调研 injection_filtering 未提但 Phase2a caveat 标注的补)
	const ig = ignore();
	for (const ignoreFile of IGNORE_FILE_NAMES) {
		const ignorePath = path.join(dir, ignoreFile);
		if (fs.existsSync(ignorePath)) {
			try {
				ig.add(fs.readFileSync(ignorePath, "utf8"));
			} catch { /* best-effort */ }
		}
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".md")) continue;
		if (ig.ignores(e.name)) continue; // B1: skip gitignored
		const p = loadPresetFile(path.join(dir, e.name));
		if (p) out.push(p);
	}
	return out;
}

/**
 * Load presets from builtin dir (pi-roles repo) + user dir + project dir.
 * Priority: builtin < user < project (project overrides user overrides builtin
 * on name collision, 抄 Factory "project 覆盖 personal").
 * B1: 处理 .gitignore (对齐 pi-core loadSkillsFromDir, 补 Phase2a caveat)。
 */
export function loadPresets(builtinDir: string, userDir: string, projectDir: string): { presets: Preset[] } {
	const byName = new Map<string, Preset>();
	for (const p of scanDir(builtinDir)) byName.set(p.name, p);
	for (const p of scanDir(userDir)) byName.set(p.name, p);
	for (const p of scanDir(projectDir)) byName.set(p.name, p);
	return { presets: Array.from(byName.values()) };
}
