import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reviewPresetContent } from "./creator";
import type { PresetSourceType, PresetTaskType } from "./types";

// save_preset tool — Phase 2 固化机制(抄 Claude plugin-dev 四段式, 精简版)。
// 设计: phase2_preset_design.md §4.3。
//
// 四段式落地(精简, spawn reviewer 留作可选增强):
// 1. 生成: 工具接收 preset 内容(name/description/task_type/content/source)
// 2. 审查: reviewPresetContent 纯函数校验合规(name 命名/desc 非空/task_type 合法/
//    source 正确 + 无垃圾指令)。这是审查子代理的规则集(Claude plugin-validator/
//    skill-reviewer 的等价)。spawn reviewer 作可选增强(实战验证后再加更重路径)。
// 3. 人确认: 工具返回审查结果+待落盘路径, 让主 agent/用户确认(autonomous 下
//    主 agent 判断是否落盘; 交互下 LLM 会问用户)。不自动落盘未确认的。
// 4. 来源分流: source=agent 默认落 ~/.pi/agent/presets/(user 全局, 私人);
//    经确认可提示提升到 project(不自动)。落盘后下次 loadPresets 扫到(热加载)。

const Params = Type.Object({
	name: Type.String({ description: "Preset name (lowercase, hyphens only, not at start/end)" }),
	description: Type.String({ description: "Preset description (what it does, when to trigger)" }),
	task_type: Type.Union(
		[
			Type.Literal("coding"),
			Type.Literal("research"),
			Type.Literal("pm"),
			Type.Literal("review"),
			Type.Literal("debug"),
		],
		{ description: "Task type this preset handles" },
	),
	content: Type.String({ description: "Preset body (workflow steps / role instructions / domain knowledge)" }),
	source: Type.Union(
		[Type.Literal("builtin"), Type.Literal("user"), Type.Literal("agent")],
		{ description: "Preset source (agent-generated defaults to user scope, not builtin)" },
	),
	allowed_roles: Type.Optional(Type.Array(Type.String())),
	allowed_tools: Type.Optional(Type.Array(Type.String())),
	confirm: Type.Optional(Type.Boolean({ description: "If true, write to disk after review passes. If false/omitted, return review result for confirmation first." })),
});

export interface SavePresetToolOptions {
	/** Override the user preset dir (for tests). Defaults to ~/.pi/agent/presets/ */
	userPresetDir?: string;
}

function defaultUserPresetDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "presets");
}

export function makeSavePresetTool(opts: SavePresetToolOptions = {}) {
	const userDir = opts.userPresetDir ?? defaultUserPresetDir();
	return defineTool({
		name: "save_preset",
		label: "Save Preset",
		description:
			"Save a workflow preset to disk (Phase 2 固化机制). Reviews content for compliance " +
			"(name/description/task_type/source + no garbage instructions) then writes to the user " +
			"preset dir if confirm=true. Agent-generated presets default to user scope (not builtin). " +
			"Call with confirm=false first to preview the review result.",
		parameters: Params,
		async execute(_id: string, params: Record<string, unknown>, _signal, _onUpdate, _ctx) {
			const name = String(params.name ?? "");
			const description = String(params.description ?? "");
			const taskType = String(params.task_type ?? "");
			const content = String(params.content ?? "");
			const source = String(params.source ?? "agent");
			const confirm = params.confirm === true;

			const review = reviewPresetContent({ name, description, taskType, source, content });

			if (!review.approved) {
				return {
					content: [{
						type: "text" as const,
						text: "Review REJECTED. Preset not saved. Fix these issues:\n" +
							review.reasons.map((r) => `- ${r}`).join("\n") +
							"\n\nAfter fixing, call save_preset again.",
					}],
					details: { approved: false, reasons: review.reasons },
				};
			}

			if (!confirm) {
				return {
					content: [{
						type: "text" as const,
						text: `Review APPROVED. Ready to save.\n` +
							`Name: ${name}\nDescription: ${description}\n` +
							`task_type: ${taskType}\nsource: ${source}\n` +
							`Target path: ${path.join(userDir, `${name}.md`)}\n\n` +
							`Call save_preset again with confirm=true to write to disk.`,
					}],
					details: { approved: true, reasons: [] },
				};
			}

			// Confirm: write to disk
			try {
				fs.mkdirSync(userDir, { recursive: true });
				const frontmatter = [
					"---",
					`name: ${name}`,
					`description: "${description.replace(/"/g, '\\"')}"`,
					`task_type: ${taskType}`,
					`allowed_roles: [${(params.allowed_roles as string[] ?? []).join(", ")}]`,
					`allowed_tools: [${(params.allowed_tools as string[] ?? []).join(", ")}]`,
					`source: ${source}`,
					`version: "1.0"`,
					`author: agent`,
					"---",
					"",
					content,
					"",
				].join("\n");
				const filePath = path.join(userDir, `${name}.md`);
				fs.writeFileSync(filePath, frontmatter, "utf8");
				return {
					content: [{
						type: "text" as const,
						text: `Preset saved to ${filePath}.\nIt will be picked up by loadPresets on next session (hot-reload via re-scan).`,
					}],
					details: { approved: true, saved: true, filePath },
				};
			} catch (e) {
				return {
					content: [{
						type: "text" as const,
						text: `Failed to save preset: ${e instanceof Error ? e.message : String(e)}`,
					}],
					details: { approved: true, saved: false, error: String(e) },
				};
			}
		},
	});
}
