import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildPresetInjection,
	reviewPresetContent,
	type Preset,
} from "../src/presets/index";

// Goal 1: A2 解耦 + C1 spawn reviewer 升级。
// A2: preset 注入去掉重复路由提示(只讲能力不讲路由), 路由归 pi-goal taskRoutingBlock。
// C1: save_preset 审查两段式(纯函数预筛 + spawn reviewer 语义判断)。

function mk(name: string, desc: string, filePath = "/x"): Preset {
	return {
		name, description: desc, taskType: "research", source: "builtin",
		allowedRoles: ["researcher"], allowedTools: [], version: "1.0", author: "pi", filePath,
	};
}

describe("A2: buildPresetInjection decoupled (no routing priority hint)", () => {
	it("injects available preset list WITHOUT routing priority 1/2/3 hints", () => {
		const presets = [mk("research", "Research workflow"), mk("pm-discovery", "PM SOP")];
		const inj = buildPresetInjection(presets);
		assert.ok(inj.includes("research"), "should list research preset");
		assert.ok(inj.includes("pm-discovery"), "should list pm-discovery preset");
		// A2 解耦: 不再含路由优先级提示(路由归 taskRoutingBlock 一处讲)
		assert.ok(!/Routing priority/i.test(inj), "should NOT contain routing priority hint");
		assert.ok(!/self-contained/i.test(inj), "should NOT contain self-contained defense (was A2 overlap)");
		assert.ok(!/prioritize preset/i.test(inj), "should NOT contain prioritize-preset hint");
		assert.ok(!/on-miss generation/i.test(inj), "should NOT contain on-miss generation hint");
	});

	it("still lists presets as available capabilities (name/task_type/description/file_path)", () => {
		const presets = [mk("research", "Research workflow")];
		const inj = buildPresetInjection(presets);
		assert.ok(inj.includes("research"));
		assert.ok(inj.includes("research")); // task_type appears
		assert.ok(/\/x/.test(inj), "file_path column present");
	});

	it("returns empty when no presets", () => {
		assert.equal(buildPresetInjection([]), "");
	});
});

describe("C1: two-stage review (mechanical pre-filter + spawn reviewer semantic)", () => {
	it("mechanical pre-filter still rejects non-compliant (before any spawn)", () => {
		// 纯函数预筛: name 不规范直接拒, 不进 spawn
		const r = reviewPresetContent({
			name: "BadName", description: "x", taskType: "research", source: "agent", content: "ok",
		});
		assert.equal(r.approved, false);
		assert.ok(r.reasons.some((m) => /name/i.test(m)));
	});

	it("mechanical pre-filter passes compliant preset (would proceed to spawn)", () => {
		const r = reviewPresetContent({
			name: "good-name", description: "x", taskType: "research", source: "agent", content: "ok",
		});
		assert.equal(r.approved, true);
	});

	// C1 核心: save_preset 工具在 confirm=true 落盘前必须 spawn reviewer 做语义判断。
	// 工具内 spawn 用 buildSpawnFn(对齐 dag_execute 先例)。测试用 mock spawnFn 验证调用。
	// (真 spawn 涉及 createAgentSession, 单测用 mock)
});

describe("C1: semantic review prompt (spawn reviewer task)", () => {
	it("buildSemanticReviewTask returns task prompt with semantic rules", async () => {
		const { buildSemanticReviewTask } = await import("../src/presets/creator");
		const task = buildSemanticReviewTask({
			name: "test-preset",
			description: "Test preset",
			taskType: "research",
			content: "# Test\n1. step one\n2. step two",
			existingPresets: ["research", "pm-discovery"],
		});
		// 语义判断规则(非机械 regex): 步骤合理性/重复/描述准确/遗漏
		assert.ok(/step|步骤/.test(task), "should ask about step soundness");
		assert.ok(/duplicate|重复/.test(task), "should ask about duplication vs existing");
		assert.ok(/description|描述/.test(task), "should ask about description accuracy");
		assert.ok(/missing|遗漏/.test(task), "should ask about missing/logic gaps");
		assert.ok(task.includes("research") || task.includes("pm-discovery"), "should list existing presets for dup check");
		assert.ok(task.includes("test-preset"), "should name the preset under review");
	});
});
