import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reviewPresetContent, buildSemanticReviewTask } from "./creator";
import type { PresetSourceType, PresetTaskType } from "./types";
import type { SpawnFn } from "../dag/executor";

// save_preset tool — Phase 2 固化机制(抄 Claude plugin-dev 四段式)。
// 设计: phase2_preset_design.md §4.3。
//
// C1 两段式审查(Goal 1 升级):
// 1. 生成: 工具接收 preset 内容(name/description/task_type/content/source)
// 2a. 纯函数预筛(机械合规): reviewPresetContent 校验 name/desc/task_type/source
//     合法 + 无垃圾指令(regex)。不过直接拒, 不进 spawn。
// 2b. spawn reviewer 语义判断: 预筛过后 spawn reviewer role 做语义审查(步骤合理性/
//     是否与现有preset重复/描述准确/遗漏), 防低质 preset 沉淀。审查规则经 task
//     prompt 传入(复用现有 reviewer, Phase2a 设计模式)。
// 3. 人确认: confirm=false 返回预览; confirm=true 落盘。
// 4. 来源分流: source=agent 默认落 ~/.pi/agent/presets/(user 全局); 下次 session 加载。
//
// 工具内 spawn 用 buildSpawnFn(对齐 dag_execute 先例)。每次 confirm=true 都 spawn
// 一个 LLM session 审查(贵但防沉淀彻底, 用户选方案 A)。

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
	confirm: Type.Optional(Type.Boolean({ description: "If true, write to disk after mechanical + semantic review pass. If false/omitted, return review result for confirmation first." })),
});

export interface SavePresetToolOptions {
	/** Override the user preset dir (for tests). Defaults to ~/.pi/agent/presets/ */
	userPresetDir?: string;
	/** Spawn function for spawning reviewer (语义审查). Required for C1 两段式.
	 *  对齐 dag_execute 用 buildSpawnFn。测试可传 mock。 */
	spawnFn?: SpawnFn;
	/** Existing preset names (for dup check in semantic review). */
	existingPresets?: string[];
}

function defaultUserPresetDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "presets");
}

export function makeSavePresetTool(opts: SavePresetToolOptions = {}) {
	const userDir = opts.userPresetDir ?? defaultUserPresetDir();
	const spawnFn = opts.spawnFn;
	return defineTool({
		name: "save_preset",
		label: "Save Preset",
		description:
			"Save a workflow preset to disk (Phase 2 固化机制). Two-stage review: " +
			"mechanical compliance (name/desc/task_type/source + no garbage) via pure function, " +
			"then spawn reviewer for SEMANTIC judgment (step soundness/duplication/description " +
			"accuracy/missing gaps) to prevent low-quality presets accumulating. " +
			"Agent-generated presets default to user scope (not builtin). " +
			"Call with confirm=false first to preview; confirm=true writes after both reviews pass.",
		parameters: Params,
		async execute(_id: string, params: Record<string, unknown>, _signal, _onUpdate, _ctx) {
			const name = String(params.name ?? "");
			const description = String(params.description ?? "");
			const taskType = String(params.task_type ?? "");
			const content = String(params.content ?? "");
			const source = String(params.source ?? "agent");
			const confirm = params.confirm === true;

			// 2a. 纯函数预筛(机械合规)
			const mechanical = reviewPresetContent({ name, description, taskType, source, content });
			if (!mechanical.approved) {
				return {
					content: [{
						type: "text" as const,
						text: "Mechanical review REJECTED. Preset not saved. Fix these issues:\n" +
							mechanical.reasons.map((r) => `- ${r}`).join("\n") +
							"\n\nAfter fixing, call save_preset again.",
					}],
					details: { stage: "mechanical", approved: false, reasons: mechanical.reasons },
				};
			}

			// confirm=false: 预览(不 spawn 语义审, 不落盘)
			if (!confirm) {
				return {
					content: [{
						type: "text" as const,
						text: `Mechanical review APPROVED. Ready for semantic review + save.\n` +
							`Name: ${name}\nDescription: ${description}\n` +
							`task_type: ${taskType}\nsource: ${source}\n` +
							`Target path: ${path.join(userDir, `${name}.md`)}\n\n` +
							`Call save_preset again with confirm=true to run semantic review (spawn reviewer) and write to disk.`,
					}],
					details: { stage: "preview", approved: true, reasons: [] },
				};
			}

			// 2b. spawn reviewer 语义判断(C1 两段式第二段)
			if (!spawnFn) {
				return {
					content: [{
						type: "text" as const,
						text: "Cannot run semantic review: spawnFn not configured (pi-roles wiring issue). Preset not saved.",
					}],
					details: { stage: "semantic", approved: false, error: "spawnFn missing" },
				};
			}
			const reviewTask = buildSemanticReviewTask({
				name, description, taskType, content,
				existingPresets: opts.existingPresets ?? [],
			});
			let semanticApproved = false;
			let semanticFeedback = "";
			try {
				const result = await spawnFn("reviewer", reviewTask);
				const text = typeof result === "string" ? result
					: (result as any)?.result ?? (result as any)?.findings?.join("\n") ?? JSON.stringify(result);
				// reviewer 返回 APPROVED/REJECTED 关键词判断
				semanticApproved = /\bAPPROVED\b/i.test(text);
				semanticFeedback = text;
			} catch (e) {
				return {
					content: [{
						type: "text" as const,
						text: `Semantic review spawn failed: ${e instanceof Error ? e.message : String(e)}. Preset not saved.`,
					}],
					details: { stage: "semantic", approved: false, error: String(e) },
				};
			}
			if (!semanticApproved) {
				return {
					content: [{
						type: "text" as const,
						text: `Semantic review REJECTED. Preset not saved. Reviewer feedback:\n${semanticFeedback}\n\nAddress the feedback and call save_preset again.`,
					}],
					details: { stage: "semantic", approved: false, feedback: semanticFeedback },
				};
			}

			// 4. 落盘
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
						text: `Preset saved to ${filePath} (passed mechanical + semantic review).\nNote: loaded on NEXT session start (loadPresets scans at session init, not real-time). Read file directly or restart to use this session.`,
					}],
					details: { stage: "saved", approved: true, saved: true, filePath },
				};
			} catch (e) {
				return {
					content: [{
						type: "text" as const,
						text: `Failed to save preset: ${e instanceof Error ? e.message : String(e)}`,
					}],
					details: { stage: "save", approved: true, saved: false, error: String(e) },
				};
			}
		},
	});
}
