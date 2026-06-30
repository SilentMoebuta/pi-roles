import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPresets, reviewPresetContent } from "../src/presets/index";

// Phase 2b: 验证新扩的 preset(code-review/feature-dev/systematic-debugging/commit-pr)
// 都在 builtin presets/ 目录, frontmatter 合规, 可被 loadPresets 加载, 且过 reviewPresetContent 审查。
// 调研: common_workflow_presets_research.md P0×3 + P1×1 推荐。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(__dirname, "..", "presets");

const NEW_PRESETS = ["code-review", "feature-dev", "systematic-debugging", "commit-pr"] as const;

describe("Phase 2b: new builtin presets load + compliant", () => {
	const { presets } = loadPresets(BUILTIN_DIR, "", "");

	for (const name of NEW_PRESETS) {
		it(`${name}.md exists and loads`, () => {
			const p = presets.find((x) => x.name === name);
			assert.ok(p, `${name} preset missing from builtin dir ${BUILTIN_DIR}`);
			assert.ok(p.description.length > 0, `${name} description empty`);
			assert.ok(["coding", "research", "pm", "review", "debug"].includes(p.taskType),
				`${name} task_type "${p.taskType}" illegal`);
			assert.ok(["builtin", "user", "agent"].includes(p.source),
				`${name} source "${p.source}" illegal`);
		});

		it(`${name} passes reviewPresetContent (compliance)`, () => {
			const p = presets.find((x) => x.name === name);
			assert.ok(p, `${name} missing`);
			// read full file content for review
			const content = fs.readFileSync(p.filePath, "utf8");
			const body = content.replace(/^---[\s\S]*?---\s*/, ""); // strip frontmatter
			const r = reviewPresetContent({
				name: p.name,
				description: p.description,
				taskType: p.taskType,
				source: p.source,
				content: body,
			});
			assert.equal(r.approved, true, `${name} should pass compliance review: ${r.reasons.join("; ")}`);
		});
	}

	it("total builtin presets now >= 6 (research + pm-discovery + 4 new)", () => {
		assert.ok(presets.length >= 6, `expected >=6 builtin presets, got ${presets.length}: ${presets.map((p) => p.name).join(",")}`);
	});
});
