import type { Preset } from "./types";

/**
 * Build the preset injection text for before_agent_start (main agent).
 * Per M1 must-fix: inject not just preset summary but also routing hint
 * ("prioritize preset > TASK-ROUTING > on-miss generation"), so presetLoader
 * is not overridden by pi-goal taskRoutingBlock.
 *
 * Returns empty string when no presets (no injection).
 */
export function buildPresetInjection(presets: Preset[]): string {
	if (presets.length === 0) return "";
	const rows = presets.map((p) =>
		`| ${p.name} | ${p.taskType} | ${p.description.replace(/\|/g, "\\|")} | ${p.filePath} |`,
	).join("\n");
	return (
		"\n\n<AVAILABLE-PRESETS>\n" +
		"The following workflow presets are loaded. Routing priority:\n" +
		"1. If a preset's task_type matches the current task, read that preset's file (path in last column) first and follow its steps.\n" +
		"2. Otherwise, follow the TASK-ROUTING block.\n" +
		"3. If still no match, generate a DAGSpec on the spot (on-miss, per TASK-ROUTING).\n\n" +
		"| preset | task_type | description | file_path |\n" +
		"|---|---|---|---|\n" +
		rows + "\n" +
		"</AVAILABLE-PRESETS>\n"
	);
}
