const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(Array.from(CHARS).map(c => c.charCodeAt(0)));
const EMPTY = new Uint8Array(0);

class Base64Encoder {
	constructor(initialCapacity = 1024) {
		this._buffer = new Uint8Array(initialCapacity);
		this._pos = 0;

		// 优化点 1：使用固定大小的缓存数组处理剩余字节，避免 slice/set 创建新对象
		this._tail = new Uint8Array(3);
		this._tailLen = 0;
	}

	_ensureCapacity(needed) {
		if (this._pos + needed <= this._buffer.length) return;
		let newLen = Math.max(this._buffer.length * 1.5, this._pos + needed);
		let nextBuffer = new Uint8Array(Math.ceil(newLen));
		nextBuffer.set(this._buffer.subarray(0, this._pos)); // 只拷贝有效部分
		this._buffer = nextBuffer;
	}

	/**
	 * @param {Uint8Array} input
	 * @returns {Uint8Array} 本次编码产生的片段视图（不含 leftover）
	 */
	encode(input) {
		let inputLen = input.length;
		if (inputLen === 0) return EMPTY;

		let inputPtr = 0;

		const buf = this._buffer;
		let outPtr = 0;

		// 优化点 2：如果上次有剩余，先尝试填满 tail
		if (this._tailLen > 0) {
			while (this._tailLen < 3 && inputPtr < inputLen) {
				this._tail[this._tailLen++] = input[inputPtr++];
			}
			if (this._tailLen < 3) return EMPTY;

			this._ensureCapacity(4);
			const a = this._tail[0], b = this._tail[1], c = this._tail[2];
			buf[outPtr++] = LOOKUP[a >> 2];
			buf[outPtr++] = LOOKUP[((a & 0x03) << 4) | (b >> 4)];
			buf[outPtr++] = LOOKUP[((b & 0x0f) << 2) | (c >> 6)];
			buf[outPtr++] = LOOKUP[c & 0x3f];
			this._tailLen = 0;
		}

		// 优化点 3：直接处理输入数组，不再创建合并后的 data 数组
		const mainEnd = inputLen - 3;
		this._ensureCapacity(((mainEnd - inputPtr) / 3) * 4);

		for (; inputPtr < mainEnd; inputPtr += 3) {
			const a = input[inputPtr], b = input[inputPtr + 1], c = input[inputPtr + 2];
			buf[outPtr++] = LOOKUP[a >> 2];
			buf[outPtr++] = LOOKUP[((a & 0x03) << 4) | (b >> 4)];
			buf[outPtr++] = LOOKUP[((b & 0x0f) << 2) | (c >> 6)];
			buf[outPtr++] = LOOKUP[c & 0x3f];
		}

		while (inputPtr < inputLen) {
			this._tail[this._tailLen++] = input[inputPtr++];
		}

		return buf.subarray(0, outPtr);
	}

	finish() {
		const buf = this._buffer;
		let outPtr = 0;

		if (this._tailLen > 0) {
			this._ensureCapacity(4);

			const a = this._tail[0];
			const b = this._tailLen > 1 ? this._tail[1] : 0;
			const PAD = 61; // '='

			buf[outPtr++] = LOOKUP[a >> 2];
			buf[outPtr++] = LOOKUP[((a & 0x03) << 4) | (b >> 4)];
			buf[outPtr++] = this._tailLen === 2 ? LOOKUP[(b & 0x0f) << 2] : PAD;
			buf[outPtr++] = PAD;

			this._tailLen = 0;
		}

		return buf.subarray(0, outPtr);
	}

	reset() { this._tailLen = 0; }
}

const JSON_CH = `":,[]{}`;
const QUOTE = 34;
const COLON = 58;
const COMMA = 44;
const LSB = 91;
const RSB = 93;
const LMB = 123;
const RMB = 125;

export async function* jsonEncode(obj) {
	const te = new TextEncoder();
	const be = new Base64Encoder();

	const sym = new Uint8Array(1);

	async function* serialize(val) {
		if (val instanceof Blob) {
			const type = val.type;
			const isTextFile = type.startsWith("text/") || type === "application/json";

			if (isTextFile) {
				yield te.encode(JSON.stringify(await val.text()));
			} else {
				sym[0] = QUOTE;
				yield sym;

				const reader = val.stream().getReader();

				if (!type.startsWith("audio/")) {
					// dataUrl
					yield te.encode(`data:${val.type};base64,`);
				}

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					yield be.encode(value);
				}

				yield be.finish();

				//sym[0] = QUOTE;
				yield sym;
			}

		} else if (Array.isArray(val)) {
			sym[0] = LSB;
			yield sym;

			if (val.length) {
				let j = 0;
				while(true) {
					yield *serialize(val[j]);
					if (++j === val.length) break;

					sym[0] = COMMA;
					yield sym;
				}
			}

			sym[0] = RSB;
			yield sym;
		} else if (val !== null && typeof val === 'object') {
			sym[0] = LMB;
			yield sym;

			const entries = Object.entries(val);
			if (entries.length) {
				let j = 0;
				while(true) {
					const [k, v] = entries[j];
					if (v === undefined) continue;

					yield te.encode(JSON.stringify(k));

					sym[0] = COLON;
					yield sym;

					yield *serialize(v);

					if (++j === entries.length) break;

					sym[0] = COMMA;
					yield sym;
				}
			}

			sym[0] = RMB;
			yield sym;
		} else {
			yield te.encode(JSON.stringify(val));
		}
	}

	yield* serialize(obj);
}