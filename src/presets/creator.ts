import type { ReviewInput, ReviewResult } from "./types";

const LEGAL_TASK_TYPES = ["coding", "research", "pm", "review", "debug"];
const LEGAL_SOURCES = ["builtin", "user", "agent"];
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/; // lowercase, hyphens allowed but not at start/end or consecutive

// Forbidden instruction patterns — reviewer role 的合规白名单检测。
// 抄 Claude plugin-dev "无垃圾指令" 护栏(preset_registry_research.md §2.3)。
// 只判合规性, 不判内容好坏(防误判)。检测: spawn 危险任务 / exec 调用 / 凭证外泄。
const FORBIDDEN_PATTERNS: RegExp[] = [
	/spawn_role\([^)]*\b(rm\s+-rf|delete|destroy|wipe)\b/i,
	/\bexec\s*\(\s*['"`]/, // exec("..." 调用
	/\beval\s*\(\s*['"`]/, // eval("..."
	/\b(curl|wget|fetch)\b[^|]*\|\s*(sh|bash)\b/i, // pipe to shell (curl/wget/fetch)
	/\b(POST|SEND|upload)\b[^]*(attacker|evil|hacker)\b/i, // exfil to attacker
	/send\s+(env|secrets?|credentials?)\s+to\b/i,
];

/**
 * Review preset content for compliance (Phase 2 抄 Claude plugin-dev 审查子代理的规则)。
 * 这是 save_preset 工具的第二段(独立审查)的规则集 —— spawn reviewer role 时
 * 经 task prompt 传入。返回 approved + reasons(若拒绝, 列具体违规)。
 */
export function reviewPresetContent(input: ReviewInput): ReviewResult {
	const reasons: string[] = [];

	// name 合规: lowercase a-z, 0-9, hyphens only (抄 pi-core skill 命名规范)
	if (!input.name || !NAME_PATTERN.test(input.name)) {
		reasons.push(`name "${input.name}" does not match [a-z0-9-]+ (lowercase, hyphens only)`);
	}

	// description 非空
	if (!input.description || !input.description.trim()) {
		reasons.push("description is required and must be non-empty");
	}

	// task_type 合法值
	if (!LEGAL_TASK_TYPES.includes(input.taskType)) {
		reasons.push(`task_type "${input.taskType}" is not one of ${LEGAL_TASK_TYPES.join("/")}`);
	}

	// source 合法值
	if (!LEGAL_SOURCES.includes(input.source)) {
		reasons.push(`source "${input.source}" is not one of ${LEGAL_SOURCES.join("/")}`);
	}

	// 无垃圾指令检测
	for (const re of FORBIDDEN_PATTERNS) {
		const m = input.content.match(re);
		if (m) {
			reasons.push(`garbage/malicious instruction detected: pattern "${m[0]}" is forbidden`);
			break; // one hit enough to flag
		}
	}

	return { approved: reasons.length === 0, reasons };
}

/**
 * C1: 构建 spawn reviewer 的语义审查 task prompt(第二段审查)。
 * 纯函数预筛(机械合规)过后, spawn reviewer 做语义判断(非机械 regex):
 * - 步骤是否合理(不是机械能判的)
 * - 是否与现有 preset 重复
 * - description 是否准确描述内容
 * - 步骤有无遗漏/逻辑漏洞
 * 这是主观判断, LLM 可能误判(防低质沉淀但非完美)。
 * 审查规则经 task prompt 传入 spawn reviewer(复用现有 role, Phase2a 设计模式)。
 */
export function buildSemanticReviewTask(input: {
	name: string;
	description: string;
	taskType: string;
	content: string;
	existingPresets: string[];
}): string {
	return (
		"You are reviewing a preset before it is saved to the preset library. " +
		"Apply SEMANTIC judgment (not mechanical regex) on these dimensions:\n\n" +
		`Preset under review: ${input.name} (task_type: ${input.taskType})\n` +
		`Description: ${input.description}\n` +
		`Content:\n---\n${input.content}\n---\n\n` +
		`Existing presets in library (check for duplication): ${input.existingPresets.join(", ") || "(none)"}\n\n` +
		"Evaluate:\n" +
		"1. STEP SOUNDNESS: Are the workflow steps reasonable and actionable? Not vague placeholders?\n" +
		"2. DUPLICATION: Does this preset duplicate an existing preset's purpose? (Check against the existing list above.)\n" +
		"3. DESCRIPTION ACCURACY: Does the description accurately describe what the preset does? Not misleading or empty?\n" +
		"4. MISSING/LOGIC GAPS: Are there missing steps or logic holes that would make the workflow fail or confuse?\n\n" +
		"Return APPROVED only if the preset is safe to save as PROVISIONAL after this review; approval is not long-term best-practice promotion. " +
		"Return REJECTED with specific, actionable feedback if any dimension fails. " +
		"Be honest — this prevents low-quality presets from accumulating in the library."
	);
}
