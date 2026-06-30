import type { Preset } from "./types";

export interface InjectionOptions {
	/** Max chars for the preset summary table. When exceeded, least-recent
	 *  presets fold to bare-name rows (no description). Default Infinity (no fold).
	 *  对齐 Claude Code skillListingBudgetFraction: 全量注入 + 超预算折叠最不常用的成裸名。
	 *  调研 injection_filtering_research.md: 业界主流是全量摘要 + 预算控制, 非 task_type 预过滤。 */
	budgetChars?: number;
	/** Explicitly hide these preset names (per-item visibility override,
	 *  对齐 Claude Code skillOverrides per-skill 可见性). */
	hidden?: Set<string>;
}

function fullRow(p: Preset): string {
	return `| ${p.name} | ${p.taskType} | ${p.description.replace(/\|/g, "\\|")} | ${p.filePath} |`;
}

/**
 * Build the preset injection text for before_agent_start (main agent).
 * Per M1 must-fix: inject not just preset summary but also routing hint
 * ("prioritize preset > TASK-ROUTING > on-miss generation"), so presetLoader
 * is not overridden by pi-goal taskRoutingBlock.
 *
 * A1 (调研 injection_filtering_research.md): 保持全量摘要注入 + 预算控制(超预算
 * 折叠最不常用的成裸名) + per-item visibility override。不引入 task_type 预过滤
 * (调研强证据: 抢 LLM 相关性判断更脆; 正文严格 just-in-time 按需 read)。
 *
 * Returns empty string when no presets (no injection).
 */
export function buildPresetInjection(presets: Preset[], opts: InjectionOptions = {}): string {
	if (presets.length === 0) return "";
	const hidden = opts.hidden ?? new Set<string>();
	const visible = presets.filter((p) => !hidden.has(p.name));
	if (visible.length === 0) return "";

	const budget = opts.budgetChars ?? Infinity;

	// A2 (调研 ext_order_research.md): pi-core 无 ext order 机制, 走自包含防御 —
	// 路由提示自包含, 不依赖 pi-goal taskRoutingBlock 先注入。注入文本含完整路由
	// 优先级说明, 即使 pi-goal 的 taskRoutingBlock 未注入或顺序颠倒, 此块仍自洽。
	const header =
		"\n\n<AVAILABLE-PRESETS>\n" +
		"The following workflow presets are loaded. Routing priority (self-contained, does not depend on any other injected block):\n" +
		"1. If a preset's task_type matches the current task, read that preset's file (path in last column) first and follow its steps.\n" +
		"2. Otherwise, if a TASK-ROUTING block exists elsewhere in context, follow it.\n" +
		"3. If still no match, generate a DAGSpec on the spot (on-miss).\n\n";

	const tableHeader =
		"| preset | task_type | description | file_path |\n" +
		"|---|---|---|---|\n";

	// Compute full-table size; if under budget, inject all full rows.
	const fullRows = visible.map(fullRow).join("\n");
	const fullTable = tableHeader + fullRows + "\n";

	if (fullTable.length <= budget) {
		return header + fullTable + "</AVAILABLE-PRESETS>\n";
	}

	// Over budget: fold least-recent presets to bare names (keep first N full).
	// "Least-recent" = later in array (presets ordered builtin<user<project,
	// project most-specific first... but folding order is by position; the
	// first presets keep full rows, later ones fold). 对齐 Claude Code
	// "fold least-used to bare name".
	const overhead = header.length + tableHeader.length + "</AVAILABLE-PRESETS>\n".length;
	const remaining = Math.max(0, budget - overhead);
	// greedy: keep full rows until budget exhausted, fold rest to bare names
	const kept: string[] = [];
	const folded: string[] = [];
	let used = 0;
	for (let i = 0; i < visible.length; i++) {
		const row = fullRow(visible[i]);
		if (used + row.length + 1 <= remaining) {
			kept.push(row);
			used += row.length + 1;
		} else {
			// fold remaining to bare names
			for (let j = i; j < visible.length; j++) {
				folded.push(visible[j].name);
			}
			break;
		}
	}
	const body = tableHeader + kept.join("\n") + (folded.length > 0 ? "\n" + folded.join("\n") : "") + "\n";
	return header + body + "</AVAILABLE-PRESETS>\n";
}
