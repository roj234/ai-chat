import {createBase64Encoder} from "@roj234/shared/base64";
import {UTF8_TEXT_ENCODER} from "@roj234/shared";

const QUOTE = 34, COLON = 58, COMMA = 44, LSB = 91, RSB = 93, LMB = 123, RMB = 125;

export const createJsonStream = (obj, replacer) => {
	const iterator= createJsonSerializer(replacer)(obj);

	return new ReadableStream({
		async pull(controller) {
			try {
				const { value, done } = await iterator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (e) {
				console.error(e);
				controller.error(e);
			}
		}
	});
}

let sharedBuffer;

/**
 * 创建一个流式 JSON 序列化器。
 * @param {Map<Object, any>} [replacer]
 * @returns {(value: unknown) => AsyncGenerator<Uint8Array, void, void>} 一个异步生成器函数，接收任意值并逐步产出 JSON 字节块。
 */
export const createJsonSerializer = (replacer) => {
	let be;

	const buf = sharedBuffer ?? new Uint8Array(4096);
	sharedBuffer = null;

	let i = 0;

	/**
	 * @param {string} text
	 * @return {Uint8Array}
	 */
	function* encodeString(text) {
		let j = 0;
		while (j < text.length) {
			const result = UTF8_TEXT_ENCODER.encodeInto(text.slice(j, Math.min(j + buf.length, text.length)), buf.subarray(i));
			i += result.written;
			j += result.read;

			if (buf.length - i < 256) {
				yield buf.slice(0, i);
				i = 0;
			}
		}
	}

	async function* serialize(val, key) {
		const fn = val?.toJSON;
		if (typeof fn === 'function') val = fn();

		if (val != null && typeof val === 'object') {
			if (replacer) val = replacer.get(val) ?? val;

			// undefined for Object.create(null)
			const ctor = val.constructor;
			const ctorName = typeof ctor === 'function' ? ctor.name : '';
			if (ctorName === 'Blob' || ctorName === 'File') {
				if (val.size <= 0) throw new Error("附件 "+(val.name || val.hash)+" 丢失或损坏");

				let isAudio;
				if (key === 'image_url' || key === 'url' || (isAudio = key === 'data')) {
					// image or audio
					buf[i++] = QUOTE;

					// _FakeBlob.stream() 返回 promise
					const reader = (await val.stream()).getReader();

					if (!isAudio) {
						// dataUrl
						yield* encodeString(`data:${val.type || 'image/png'};base64,`);
					}

					if (i) {
						yield buf.slice(0, i);
						i = 0;
					}

					be ??= createBase64Encoder(false, buf.length, buf);

					try {
						while (true) {
							const {done, value} = await reader.read();
							if (done) break;

							for (const chunk of be.encode(value)) {
								yield chunk.slice();
							}
						}
					} catch (e) {
						throw new Error("附件 "+(val.name || val.hash)+" 丢失或损坏");
					}

					i = be.finish().length;
					buf[i++] = QUOTE;
				} else {
					// maybe text, video is not supported yet.
					yield* encodeString(JSON.stringify(await val.text()));
				}
			} else {
				if (Array.isArray(val)) {
					buf[i++] = LSB;

					if (val.length) {
						let j = 0;
						while(true) {
							yield *serialize(val[j]);
							if (++j === val.length) break;
							buf[i++] = COMMA;
						}
					}

					buf[i++] = RSB;
				} else {
					buf[i++] = LMB;

					const keys = Object.keys(val);
					let prior = false;
					for (let j = 0; j < keys.length; j++) {
						const k = keys[j];
						const v = val[k];
						if (v === undefined) continue;

						if (prior) buf[i++] = COMMA;

						yield* encodeString(JSON.stringify(k));
						buf[i++] = COLON;

						yield *serialize(v, k);
						prior = true;
					}

					buf[i++] = RMB;
				}

			}
		} else {
			yield* encodeString(typeof val === 'string' ? JSON.stringify(val) : String(val));
		}
	}

	return async function *(obj) {
		yield *serialize(obj);
		if (i) {
			yield buf.slice(0, i);
			i = 0;
		}
		sharedBuffer = buf;
	};
};
