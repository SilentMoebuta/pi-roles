export type PresetSourceType = "builtin" | "user" | "agent";

export type PresetTaskType = "coding" | "research" | "pm" | "review" | "debug";
export type PresetLifecycle = "stable" | "provisional";

export interface PresetFrontmatter {
	name?: string;
	description?: string;
	task_type?: string;
	allowed_roles?: string[];
	allowed_tools?: string[];
	source?: string;
	version?: string;
	author?: string;
	lifecycle?: string;
	validation?: string;
	[key: string]: unknown;
}

export interface Preset {
	name: string;
	description: string;
	taskType: PresetTaskType;
	allowedRoles: string[];
	allowedTools: string[];
	source: PresetSourceType;
	version: string;
	author: string;
	filePath: string;
	lifecycle: PresetLifecycle;
	validation: string;
}

export interface ReviewInput {
	name: string;
	description: string;
	taskType: string;
	source: string;
	content: string;
}

export interface ReviewResult {
	approved: boolean;
	reasons: string[];
}
