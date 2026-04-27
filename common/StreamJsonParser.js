
const WHITESPACE = new Set("\r\n\t ".split(""));
const NUMBER = new Set("0123456789-.".split(""));

// 我尝试让DeepSeek V4 Pro实现这个
// 它花了30分钟成功实现了
// 但用了500行代码，差不多是我的两倍
// 而且我的实现性能好 ~27%

const EXC = (excepting, found) => {
	throw "excepting " + excepting + " but found " + JSON.stringify(found);
};

/**
 * 流式增量 JSON 解析器。
 * 允许在 JSON 数据尚未完整接收时，通过 `write` 方法逐块输入字符，并实时触发回调处理已解析的节点。
 * 特别支持对长字符串值的“部分更新”同步。
 *
 * @param {function(path: (string|number)[], value: any, is_partial: boolean): void} onValue
 * 当解析到新值或字符串片段时的回调函数。
 * - `path`: 当前值的路径数组（包含键名或数组索引）。
 * - `value`: 解析到的值。如果是字符串片段，则为片段内容。
 * - `is_partial`: 为 true 时表示 value 仅为字符串的一部分，常用于流式处理大文本或 AI 响应。
 *
 * @param {boolean=false} emitDelta 当解析字符串未完成时，回调完整的已解析字符串(prefix)，还是仅新增部分(delta)
 * - 无论如何，is_partial=false时都是完整字符串
 *
 * @returns {{write: (function(string): void), end: (function(): any)}}
 * 返回一个包含 `write` 和 `end` 方法的对象。
 *
 * @example
 * const parser = StreamJsonParser((path, val, partial) => {
 *   console.log(`Path: ${path.join('.')}, Value: ${val}, Partial: ${partial}`);
 * });
 * parser.write('{"text": "hello ');
 * parser.write('world"}');
 * const result = parser.end();
 */
export function StreamJsonParser(onValue, {emitDelta = false} = {}) {
	let root;
	const stack = [];
	const path = [];

	const
		STATE_STR = 0,
		STATE_STR_ESC = 1,
		STATE_STR_UNICODE = 2,
		STATE_LIT = 3,
		STATE_NUM = 4,

		STATE_NORM = 5,
		OBJECT_KEY_AFTER = 6,
		OBJECT_BEGIN = 7,
		AFTER = 8,
		ENDED = 9;

	/** @type {string|null} */
	let key;

	let state = STATE_NORM;
	/** @type {string} */
	let buf;
	/** @type {number} */
	let bufLastPartialSyncIdx;
	/** @type {number} */
	let index;
	let literal;
	/** @type {string} */
	let unicode;

	let errorIndex = 0;

	function pushValue(obj, partial = false) {
		if (root === undefined) {
			root = obj;
			if (!partial) {
				state = ENDED;
				return;
			}
		} else {
			const container = stack.at(-1);
			if (Array.isArray(container)) {
				onValue(path, obj, partial);
				container.push(obj);
			} else {
				if (key == null) {
					key = obj;
					state = OBJECT_KEY_AFTER;
					path.push(key);
					return;
				} else {
					onValue(path, obj, partial);
					container[key] = obj;
					key = null;
				}
			}
		}
		state = AFTER;
	}

	function enterStringMode() {
		buf = '';
		bufLastPartialSyncIdx = 0;
		state = STATE_STR;
	}

	function write(chars) {
		for (const ch of chars) {
			errorIndex++;

			if (state >= STATE_NORM && WHITESPACE.has(ch)) continue;

			switch (state) {
				case ENDED: throw "Unexpected non-whitespace character after JSON";
				// {" or {}
				//  ^     ^
				case OBJECT_BEGIN: {
					if (ch === '"') {
						enterStringMode();
						continue;
					} else if (ch === '}') {
						state = STATE_NORM;
						write(ch);
						break;
					} else {
						EXC('"\\"" or "}"', ch);
					}
				}
				// {"a":
				//     ^
				case OBJECT_KEY_AFTER:
					if (ch !== ':') EXC('":"', ch);
					state = STATE_NORM;
					continue;
				// {"a":1  or [1
				//       ^      ^
				case AFTER:
					if (ch === ',') {
						if (Array.isArray(stack.at(-1))) {
							state = STATE_NORM;
							path[path.length-1]++;
						} else {
							state = OBJECT_BEGIN;
							path.pop();
						}
						continue;
					}

					if (ch !== ']' && ch !== '}') EXC("TERM", ch);
					state = STATE_NORM;
					break;
			}
			switch (state) {
				case STATE_NORM: {
					switch (ch) {
						case 't':
							buf = "true";
							index = 1;
							literal = true;
							state = STATE_LIT;
						break;
						case 'f':
							buf = "false";
							index = 1;
							literal = false;
							state = STATE_LIT;
						break;
						case 'n':
							buf = "null";
							index = 1;
							literal = null;
							state = STATE_LIT;
						break;
						case '{': {
							const obj = {};
							pushValue(obj, 1);
							stack.push(obj);
							state = OBJECT_BEGIN;
						}
						break;
						case '[': {
							const obj = [];
							pushValue(obj, 1);
							stack.push(obj);
							path.push(0);
							state = STATE_NORM;
						}
						break;
						case '}':
						case ']': {
							const last = stack.pop();
							console.assert(typeof last === "object", "stackTop must be object", last);
							const lastIsArray = Array.isArray(last);
							if (lastIsArray !== (ch === ']')) EXC(lastIsArray ? '"]"' : '"}"', ch);

							path.pop();
							state = stack.length ? AFTER : ENDED;
							onValue(path, last, false);
						}
						break;
						case '"':
							enterStringMode();
						break;
						default:
							if (NUMBER.has(ch)) {
								buf = ch;
								state = STATE_NUM;
								break;
							}
							throw "Unexpected token "+JSON.stringify(ch);
					}
				}
				break;
				case STATE_LIT: {
					if (ch !== buf[index]) EXC(JSON.stringify(buf)+" (index "+index+")", ch);

					if (++index === buf.length) {
						pushValue(literal);
						index = 0;
						buf = '';
					}
				}
				break;
				case STATE_STR: {
					if (ch === '\\') {
						state = STATE_STR_ESC;
					} else if (ch === '"') {
						pushValue(buf);
					} else {
						buf += ch;
					}
				}
				break;
				case STATE_STR_ESC: {
					state = STATE_STR;
					switch (ch) {
						default: buf += ch; break;
						//case '"': buf += '"'; break;
						//case '\\': buf += '\\'; break;
						//case '/': buf += '/'; break;
						case 'b': buf += '\b'; break;
						case 'f': buf += '\f'; break;
						case 'n': buf += '\n'; break;
						case 'r': buf += '\r'; break;
						case 't': buf += '\t'; break;
						case 'u': state = STATE_STR_UNICODE; unicode = ''; break;
					}
				}
				break;
				case STATE_STR_UNICODE: {
					if (unicode.length < 4) unicode += ch;
					if (unicode.length === 4) {
						const codePoint = parseInt(unicode, 16);
						if (isNaN(codePoint)) throw `invalid escape \\u${unicode}`;
						buf += String.fromCharCode(codePoint);
						state = STATE_STR;
					}
				}
				break;
				case STATE_NUM: {
					if (ch === ']' || ch === '}' || ch === ',' || ch === '\0') {
						const num = Number(buf);
						if (isNaN(num)) throw "invalid number "+buf;
						pushValue(num);
						if (ch !== '\0') write(ch);
					} else {
						buf += ch;
					}
				}
				break;
			}
		}

		if (state <= STATE_STR_UNICODE && buf.length > bufLastPartialSyncIdx && (key != null || Array.isArray(stack.at(-1)))) {
			onValue(path, buf.slice(bufLastPartialSyncIdx), true);
			if (emitDelta) bufLastPartialSyncIdx = buf.length;
		}
	}

	return {
		get pos() {
			return errorIndex;
		},
		write,
		end() {
			if (state !== ENDED) {
				if (state === STATE_NUM && root === undefined) {
					write('\0');
				} else {
					throw "Unexpected end of JSON input (t="+state+", b="+JSON.stringify(buf)+", s="+stack.length+")";
				}
			}
			return root;
		}
	}
}
