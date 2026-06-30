export type PresetSourceType = "builtin" | "user" | "agent";

export type PresetTaskType = "coding" | "research" | "pm" | "review" | "debug";

export interface PresetFrontmatter {
	name?: string;
	description?: string;
	task_type?: string;
	allowed_roles?: string[];
	allowed_tools?: string[];
	source?: string;
	version?: string;
	author?: string;
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
