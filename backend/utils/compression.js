import {decodeMsg, encodeMsg} from "../../common/Msgpack.js";
import {brotliCompressSync, brotliDecompressSync, constants} from 'node:zlib';
import {COMPRESSION_LEVEL, COMPRESSION_MSGPACK_SCHEMA, COMPRESSION_START_SIZE} from "../config.js";

const IS_SQLITE = true;

// 注意，这些schema只能追加，规则和protobuf相同
const conversation_schema = [
	"activatedModules", "allowedTools", "grantedTools",
	"branches"
];
const message_schema = [
	// 未来支持枚举类型？
	//["role",
	//	["user", "assistant", "system"]
	//],

	"role",
	"model",
	["content",
		["type", "text",
			["image_url", ["url"]],
			["input_audio", ["data", "format"]]
		]
	],
	["think",
		["duration", "content", "format"]
	],
	"finish_reason",
	["reasoning_details",
		["index", "type", "text", "format", "data", "signature", "summary"]
	],
	["tool_calls",
		["id", "type",
			["function", ["name", "arguments"]]
		]
	],
	["tool_responses",
		["time", "content", "success"]
	]
];
const statistic_schema = [
	"preset_id", "request_id", "provider",
	"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens",
	"latency", "ttft", "finish_reason", "cost", "currency",
];

const generic_schema = [];
for (let i = 0; i < generic_schema.length; i++) {
	generic_schema[i] = [generic_schema[i], generic_schema];
}

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
 * @return {Uint8Array|Buffer|string}
 */
function compressIfEnabled(data, schema) {
	let packed;

	if (COMPRESSION_MSGPACK_SCHEMA) {
		packed = encodeMsg(data, schema);
	} else {
		packed = JSON.stringify(data);
		if (!IS_SQLITE) packed = new TextEncoder().encode(packed);
	}

	if (packed.length > COMPRESSION_START_SIZE) {
		const compressed = brotliCompressSync(packed, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: COMPRESSION_LEVEL,
			},
		});

		if (compressed.length + 1 < packed.length) {
			const header = Buffer.allocUnsafe(1);
			header[0] = 0xC1;
			return Buffer.concat([header, compressed]);
		}
	}

	return packed;
}

export const compressMessage = (data) => compressIfEnabled(data, message_schema);
/** @param {Uint8Array|Object} data */
export const decompressMessage = (data) => decompressIfNeeded(data, message_schema);

export const compressConversation = (data) => compressIfEnabled(data, conversation_schema);
/** @param {Uint8Array|Object} data */
export const decompressConversation = (data) => decompressIfNeeded(data, conversation_schema);

export const compressStatistics = (data) => compressIfEnabled(data, statistic_schema);
/** @param {Uint8Array|Object} data */
export const decompressStatistics = (data) => decompressIfNeeded(data, statistic_schema);

export const compressGeneric = compressIfEnabled;//(data) => compressIfEnabled(data, generic_schema);
/** @param {Uint8Array|Object} data */
export const decompressGeneric = decompressIfNeeded;//(data) => decompressIfNeeded(data, generic_schema);