import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadPresets,
	buildPresetInjection,
	type Preset,
} from "../src/presets/index";

// A1 预算折叠 + B1 .gitignore 处理。调研: injection_filtering_research.md
// 结论: 业界主流是全量摘要注入 + 上下文预算控制(超预算折叠最不常用的成裸名) + 正文 just-in-time。
// 不引入 task_type 预过滤(调研强证据反对, 抢 LLM 相关性判断更脆)。

function mkPreset(dir: string, name: string, desc: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, `${name}.md`);
	fs.writeFileSync(p, `---
name: ${name}
description: "${desc}"
task_type: research
allowed_roles: [researcher]
source: builtin
---
# ${name}
body
`);
	return p;
}

function mk(name: string, desc: string, filePath = "/x"): Preset {
	return {
		name, description: desc, taskType: "research", source: "builtin",
		allowedRoles: ["researcher"], allowedTools: [], version: "1.0", author: "pi", filePath, lifecycle: "stable", validation: "",
	};
}

describe("A1: buildPresetInjection budget folding", () => {
	it("injects all presets as full rows when under budget", () => {
		const presets = [mk("a", "desc a"), mk("b", "desc b")];
		const inj = buildPresetInjection(presets, { budgetChars: 10000 });
		assert.ok(inj.includes("desc a"));
		assert.ok(inj.includes("desc b"));
		assert.ok(inj.includes("| a |"));
	});

	it("folds least-recent presets to bare names when over budget", () => {
		// 3 presets, tiny budget → some should fold to bare name (no description column)
		const presets = [
			mk("aaa", "long description one"),
			mk("bbb", "long description two"),
			mk("ccc", "long description three"),
		];
		const inj = buildPresetInjection(presets, { budgetChars: 150 });
		// at least one preset should appear as bare name (folded), not full row
		const fullRows = (inj.match(/^\| \w+ \|/gm) || []).length;
		const bareNames = (inj.match(/^\w+$/gm) || []).length;
		// folding happened: some bare names present OR fewer full rows than presets
		assert.ok(fullRows < presets.length || bareNames > 0,
			`expected some folding, fullRows=${fullRows} presets=${presets.length} bareNames=${bareNames}`);
	});

	it("respects explicit per-preset visibility override (hide some)", () => {
		const presets = [
			mk("visible", "show me"),
			mk("hidden", "hide me"),
		];
		const inj = buildPresetInjection(presets, {
			budgetChars: 10000,
			hidden: new Set(["hidden"]),
		});
		assert.ok(inj.includes("visible"));
		assert.ok(!inj.includes("hide me"), "hidden preset description should not appear");
	});

	it("returns empty when no presets", () => {
		assert.equal(buildPresetInjection([]), "");
	});

	it("default budget (no option) injects all full (backward compat)", () => {
		const presets = [mk("a", "desc a"), mk("b", "desc b")];
		const inj = buildPresetInjection(presets);
		assert.ok(inj.includes("desc a"));
		assert.ok(inj.includes("desc b"));
	});
});

describe("B1: loadPresets respects .gitignore", () => {
	it("skips presets matching .gitignore patterns", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presets-gitignore-"));
		try {
			mkPreset(tmp, "visible", "show");
			mkPreset(tmp, "ignored", "hide");
			fs.writeFileSync(path.join(tmp, ".gitignore"), "ignored.md\n");
			const { presets } = loadPresets(tmp, "", "");
			const names = presets.map((p) => p.name);
			assert.ok(names.includes("visible"), "visible should load");
			assert.ok(!names.includes("ignored"), "ignored should be skipped by .gitignore");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("loads all when no .gitignore present", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presets-nogit-"));
		try {
			mkPreset(tmp, "a", "desc a");
			mkPreset(tmp, "b", "desc b");
			const { presets } = loadPresets(tmp, "", "");
			assert.equal(presets.length, 2);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
