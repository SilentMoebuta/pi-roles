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
	const description = `${p.lifecycle === "provisional" ? "[provisional] " : ""}${p.description}`;
	return `| ${p.name} | ${p.taskType} | ${description.replace(/\|/g, "\\|")} | ${p.filePath} |`;
}

/**
 * Build the preset injection text for before_agent_start (main agent).
 *
 * A2 解耦(调研 injection_filtering_research.md + ext_order_research.md):
 * preset 注入只讲'available preset 列表'(能力清单), 不讲路由规则。
 * 路由规则归 pi-goal taskRoutingBlock 一处讲(默认装 pi-goal+pi-roles 两 ext)。
 * 对标 Claude Code available_skills: 只讲 skill 可用, 路由靠 LLM 从 description
 * 自主判断。pi-goal 没装时 preset 靠 LLM 从 description 摸(可接受, 默认装两 ext)。
 *
 * A1 预算折叠保留: 超 budgetChars 折叠最不常用成裸名(对齐 Claude Code
 * skillListingBudgetFraction)。当前未接线(index.ts 默认 Infinity), 等超预算时接。
 *
 * Returns empty string when no presets (no injection).
 */
export function buildPresetInjection(presets: Preset[], opts: InjectionOptions = {}): string {
	if (presets.length === 0) return "";
	const hidden = opts.hidden ?? new Set<string>();
	const visible = presets.filter((p) => !hidden.has(p.name));
	if (visible.length === 0) return "";

	const budget = opts.budgetChars ?? Infinity;

	const header =
		"\n\n<AVAILABLE-PRESETS>\n" +
		"The following workflow presets are loaded. Read a preset's file (path in last column) when the task matches its description.\n\n";

	const tableHeader =
		"| preset | task_type | description | file_path |\n" +
		"|---|---|---|---|\n";

	const fullRows = visible.map(fullRow).join("\n");
	const fullTable = tableHeader + fullRows + "\n";

	if (fullTable.length <= budget) {
		return header + fullTable + "</AVAILABLE-PRESETS>\n";
	}

	const overhead = header.length + tableHeader.length + "</AVAILABLE-PRESETS>\n".length;
	const remaining = Math.max(0, budget - overhead);
	const kept: string[] = [];
	const folded: string[] = [];
	let used = 0;
	for (let i = 0; i < visible.length; i++) {
		const row = fullRow(visible[i]);
		if (used + row.length + 1 <= remaining) {
			kept.push(row);
			used += row.length + 1;
		} else {
			for (let j = i; j < visible.length; j++) {
				folded.push(visible[j].name);
			}
			break;
		}
	}
	const body = tableHeader + kept.join("\n") + (folded.length > 0 ? "\n" + folded.join("\n") : "") + "\n";
	return header + body + "</AVAILABLE-PRESETS>\n";
}
