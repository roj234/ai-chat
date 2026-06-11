import {bakeSchema} from "unconscious/common/msgpack.js";

export const msgpack_schema_version = "9";
export const msgpack_schema = [];
msgpack_schema.push(
	// generic
	"id", "title", "time", "owner",
	"type", "name",
	["$", msgpack_schema, ["BlobH", "Map", "Set", "SET", "ARR", "DEL", "STR"]],
	"hash", "size", "lastModified",
	"error",

	// conversation
	"activatedModules", "allowedTools", "grantedTools",
	"bm_leaf", "bm_dummy", "resumeId",

	// messages
	["role", null, ["system", "user", "assistant"]],
	"model",
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
		["time", "content", "success"]
	],

	// logs
	"preset_id", "request_id", "provider",
	"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens",
	"duration", "latency", "cost",
	["currency", null, ["USD", "CNY"]],
	"rowid",
);

bakeSchema(msgpack_schema);