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
