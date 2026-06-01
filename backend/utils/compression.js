import {bakeSchema, decodeMsg, encodeMsg} from "unconscious/common/msgpack.js";
import {brotliCompress, brotliDecompressSync, constants} from 'node:zlib';
import {DB_COMPRESS_LEVEL, DB_COMPRESS_MIN_SIZE, DB_USE_MSGPACK_SCHEMA} from "../config.js";
import {s2c_schema} from "../../common/MsgpackSchema.js";

const IS_SQLITE = true;

// 注意，这些schema只能追加，规则和protobuf相同
const conversation_schema = [
	"activatedModules", "allowedTools", "grantedTools",
	"bm_leaf", "bm_dummy"
];
const finish_reason = ["finish_reason", null, ["stop", "length", "tool_calls", "error", "interrupt"]];
const message_schema = [
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
	finish_reason,
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
	"name"
];
const log_schema = [
	"model", "request_id", "provider",
	"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens",
	"duration", "latency",
	finish_reason,
	"cost",
	["currency", null, ["USD", "CNY"]],
];

bakeSchema(conversation_schema);
bakeSchema(message_schema);
bakeSchema(log_schema);

export function deserializeRow(row, decompression = decompressGeneric) {
	const {data, ...rest} = row;
	const v = decompression(data);
	for (const key of Object.keys(rest)) {
		if (null == v[key]) v[key] = rest[key];
	}
	return v;
}

/**
 *
 * @param {Uint8Array|string} data
 * @param {Object} [schema = null]
 * @return {Object}
 */
function decompressIfNeeded(data, schema) {
	if (typeof data === 'string') return JSON.parse(data);

	const [first] = data;
	if (first === 123) { // '{' 不排除和msgpack的某些index重复。
		try {
			return JSON.parse(new TextDecoder().decode(data));
		} catch {}
	}

	// 0xC1 是 msgpack 的保留字
	if (first === 0xC1) data = brotliDecompressSync(data.subarray(1));
	return decodeMsg(data, {schema});
}

/**
 *
 * @param {Object} data
 * @param {Object} [schema = null]
 * @return {Buffer|Promise<Buffer>}
 */
function compressIfEnabled(data, schema) {
	let packed;

	if (DB_USE_MSGPACK_SCHEMA) {
		packed = encodeMsg(data, schema);
	} else {
		packed = JSON.stringify(data);
		if (!IS_SQLITE) packed = new TextEncoder().encode(packed);
	}

	if (packed.length > DB_COMPRESS_MIN_SIZE) {
		return new Promise((resolve, reject) => {
			brotliCompress(packed, {
				params: {
					[constants.BROTLI_PARAM_QUALITY]: DB_COMPRESS_LEVEL,
				},
			}, (error, compressed) => {
				if (error) reject(error);

				if (compressed.length + 1 < packed.length) {
					const header = Buffer.allocUnsafe(1);
					header[0] = 0xC1;
					resolve(Buffer.concat([header, compressed]));
				} else {
					resolve(packed);
				}
			});
		});
	}

	return packed;
}

export const compressMessage = (data) => compressIfEnabled(data, message_schema);
/** @param {Uint8Array|Object} data */
export const decompressMessage = (data) => decompressIfNeeded(data, message_schema);

export const compressConversation = (data) => compressIfEnabled(data, conversation_schema);
/** @param {Uint8Array|Object} data */
export const decompressConversation = (data) => decompressIfNeeded(data, conversation_schema);

export const compressLog = (data) => compressIfEnabled(data, log_schema);
/** @param {Uint8Array|Object} data */
export const decompressLog = (data) => decompressIfNeeded(data, log_schema);

export const compressGeneric = compressIfEnabled;//(data) => compressIfEnabled(data, generic_schema);
/** @param {Uint8Array|Object} data */
export const decompressGeneric = decompressIfNeeded;//(data) => decompressIfNeeded(data, generic_schema);