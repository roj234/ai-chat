import {bakeSchema} from "unconscious/common/msgpack.js";

export const s2c_schema_version = "2";
export const s2c_schema = [];
s2c_schema.push(
	// generic
	"id", "title", "time",
	"type", "name",
	["$", null, ["BlobH", "Map", "Set"]],
	"hash", "size", /*"name", */

	// conversation
	"activatedModules", "allowedTools", "grantedTools",
	"bm_leaf", "bm_dummy",

	// messages
	["role", null, ["system", "user", "assistant"]],
	"model",
	["content",
		[
			["type", null, ["text", "image_url", "input_audio"]],
			"text",
			["image_url", [["url", s2c_schema]]],
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
);

export const c2s_schema_version = s2c_schema_version;
export const c2s_schema = s2c_schema;

bakeSchema(s2c_schema);