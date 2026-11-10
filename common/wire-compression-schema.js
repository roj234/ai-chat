import {bakeSchema} from "@roj234/msgpack";

export const msgpack_schema_version = "15";
export const msgpack_schema = [];
msgpack_schema.push(
	// generic
	"id", "title", "time", "owner",
	"type", "name", "parent",
	["$", msgpack_schema, ["BlobH", "Map", "Set", "=", "-", "s", "["]],
	"hash", "size", "lastModified",
	"error",
	"status",

	// conversation
	"activatedModules", "tools", "grantedTools",
	"bm_leaf",
	"resumeParent", "resumeId",
	"roleId",
	"contextUsage",

	// FileSystem
	["mnt", msgpack_schema],
	["fs_type", null, ['db', 'api', 'local', 'config', 'opfs', 'vfs']],
	"fs_base", "fs_server", "fs_builtin", "fs_readonly", "fs_branch",
	["fs_ACL",
		[
			"ignore",
			"acl"
		]
	],
	["fs_events",
		[
			"runId",
			"type",
			"pid",
			"explanation",
			"cwd",
			"start"
		]
	],

	// subagent
	"presets", "overrides",
	"sa_notify", "sa_async",

	// inject message
	["pendingMessages", msgpack_schema],

	// message
	["role", null, ["system", "user", "assistant"]],
	"model",
	["folded", msgpack_schema],
	"foldGroup",
	["content",
		[
			["type", null, ["text", "image_url", "input_audio"]],
			"text",
			["image_url", [["url", msgpack_schema]]],
			["input_audio", ["data", "format"]]
		]
	],
	["think",
		[
			"duration",
			"content",
			["format", null, ["r", "rc", "mthink"]]
		]
	],
	["finish_reason", null, ["stop", "length", "tool_calls", "error", "interrupt"]],
	["reasoning_details",
		[
			"index",
			["type", null, ['reasoning.text','reasoning.summary','reasoning.encrypted']],
			"text",
			["format", null, ['unknown', 'openai-responses-v1', 'xai-responses-v1', 'anthropic-claude-v1', 'google-gemini-v1']],
			"data", "signature", "summary"
		]
	],
	["tool_calls",
		[
			"id",
			["type", null, ["function"]],
			["function", ["name", "arguments"]]
		]
	],
	["tool_responses",
		[
			"time", "content", "success", "duration",
			["delegatedCalls", msgpack_schema],
		]
	],
	"label",

	// logs
	"preset_id", "request_id", "provider",
	"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens",
	"duration", "latency", "cost",
	["currency", null, ["USD", "CNY"]],
	"rowid", "usage",
);

bakeSchema(msgpack_schema);