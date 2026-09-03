import {fastObjectMap} from "../src/utils/pure-utils.js";

const ESCAPES = fastObjectMap({
	0x08: 'b',
	0x09: 't',
	0x0a: 'n',
	0x0b: 'v',
	0x0c: 'f',
	0x0d: 'r',
	0x5c: '\\',
	36: '${',
	96: '`',
});

const INLINE_ARRAY_TYPE = fastObjectMap({
	'null': true,
	"number": true,
	"boolean": true,
	"bigint": true
});

const NULLISH_TYPE = fastObjectMap({
	'undefined': true,
	"function": true,
	"symbol": true,
});

/** 判断键名是否可以不加双引号（JSON5 规范） */
const IDENTIFIER_RE = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const NUMERIC_KEY_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

const isJSON5Key = key => IDENTIFIER_RE.test(key) || NUMERIC_KEY_RE.test(key);

/** 对带 toJSON 的对象做预处理 */
const prepare = value => typeof value?.toJSON === "function" ? value.toJSON() : value;

/** 键名序列化：合法则裸写，否则用双引号 */
const stringifyKey = key => isJSON5Key(key) ? key : stringifyString(key);

const REGEXP_BACKTICK = /[\x00-\x08\x0B-\x1E\\`\u2028\u2029\u3000\u00a0\uFEFF\u200B]|\${/g;
const REGEXP_QUOTE = /[\x00-\x1E\\\u2028\u2029\u3000\u00a0\uFEFF\u200B"]/g;

/**
 *
 * @param {string} s
 * @return {string}
 */
const stringifyString = s => {
	const useBacktick = s.includes("\n");
	const escaped = s.replace(useBacktick ? REGEXP_BACKTICK : REGEXP_QUOTE, (match) => {
		const code = match.charCodeAt(0);
		return "\\"+(ESCAPES[code] ?? (code < 0x20 ? "x"+code.toString(16).padStart(2, "0") : "u"+code.toString(16).padStart(4, "0")));
	});
	const escapeChar = useBacktick ? '`' : '"';
	return escapeChar + escaped + escapeChar;
};

const TKV = (k, v) => v;

/**
 *
 * @param {any} value
 * @param {function(string, Object): *} [replacer]
 * @param {number | string} [indent]
 * @return {string}
 */
export function stringify(value, replacer, indent = 2) {
	const space = typeof indent === "string" ? indent : " ".repeat(Math.max(0, indent));
	const seen = new Map();

	const prepared = prepare(value);
	if (NULLISH_TYPE[typeof prepared]) return;
	return serialize(prepared, 0, space, seen, replacer ?? TKV);
}

/**
 * @param {any} value
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serialize(value, depth, space, seen, replacer) {
	switch (typeof value) {
		case "string":return stringifyString(value);
		case "number":case "boolean":return String(value);
		case "bigint":return String(value)+"n";
		case "object":
			if (value === null) return "null";

			// 解析器并不支持，但是比报错更麻烦的是一样的对象变成了不一样的
			if (seen.has(value)) return "*#"+seen.get(value)+" /* Circular reference */";
			seen.set(value, seen.size);

			// TODO handle Uint8Array
			if (Array.isArray(value)) {
				return serializeArray(value, depth, space, seen, replacer);
			}
			return serializeObject(value, depth, space, seen, replacer);
		case "undefined":
		case "function":
		case "symbol":
		default:
			return "null";
	}
}

/**
 * @param {Array} arr
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serializeArray(arr, depth, space, seen, replacer) {
	if (!arr.length) return "[]";

	const items = arr.map(item => {
		const prepared = prepare(item);
		return NULLISH_TYPE[typeof prepared] ? null : prepared;
	});

	let result;

	if (items.every(v => INLINE_ARRAY_TYPE[typeof v])) {
		result = "[ "+items.join(", ")+" ]";
	} else {
		const currentIndent = space.repeat(depth);
		result = "[\n";

		const childIndent = space.repeat(++depth);
		let i = 0;
		for (;;) {
			result += childIndent + serialize(items[i], depth, space, seen, replacer);
			if (++i === items.length) break;
			result += ',\n';
		}
		result += "\n" + currentIndent + "]";
	}

	return result;
}

/**
 * @param {Object} obj
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serializeObject(obj, depth, space, seen, replacer) {
	const entries = Object.entries(obj);
	if (!entries.length) return "{}";

	const currentIndent = space.repeat(depth);
	const childIndent = space.repeat(++depth);

	let result = '{\n';
	let delimiter = '';

	for (const [key, value] of entries) {
		const prepared = prepare(replacer(key, value));
		if (NULLISH_TYPE[typeof prepared]) continue;

		result += delimiter;
		result += childIndent + stringifyKey(key) + ": " + serialize(prepared, depth, space, seen, replacer);
		delimiter = ",\n";
	}

	return result + "\n" + currentIndent + "}";
}