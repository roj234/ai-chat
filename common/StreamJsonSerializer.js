import {createBase64Encoder} from "unconscious/common/Base64.js";
import {UTF8_TEXT_ENCODER} from "unconscious/shared.js";

const buffer = new Uint8Array([34,58,44,91,93,123,125]);
const symbols = Array.from({ length: 7 }).map((item, i) => buffer.subarray(i, i+1));
const QUOTE = 0, COLON = 1, COMMA = 2, LSB = 3, RSB = 4, LMB = 5, RMB = 6;

export const createJsonStream = (obj, replacer) => {
	const iterator= createJsonSerializer(replacer)(obj);
	return new ReadableStream({
		async pull(controller) {
			const { value, done } = await iterator.next();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		}
	});
}

/**
 * 创建一个流式 JSON 序列化器。
 * @param {Map<Object, any>} [replacer]
 * @returns {(value: unknown) => AsyncGenerator<Uint8Array, void, void>} 一个异步生成器函数，接收任意值并逐步产出 JSON 字节块。
 */
export const createJsonSerializer = (replacer) => {
	let be;

	async function* serialize(val, key) {
		if (replacer && typeof val === 'object')
			val = replacer.get(val) ?? val;

		const constructor = val?.constructor;
		if (constructor === Blob || constructor === File) {
			if (val.size === 0) throw "文件"+val.name+"的数据不完整或已损坏。请尝试重新上传";

			let isAudio;
			if (key === 'url' || (isAudio = key === 'data')) {
				// image or audio
				yield symbols[QUOTE];

				const reader = val.stream().getReader();

				if (!isAudio) {
					// dataUrl
					yield UTF8_TEXT_ENCODER.encode(`data:${val.type||'image/png'};base64,`);
				}

				if (!be) be = createBase64Encoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					for (const chunk of be.encode(value)) {
						yield chunk.slice();
					}
				}

				yield be.finish();
				yield symbols[QUOTE];
			} else {
				// maybe text, video is not supported yet.
				yield UTF8_TEXT_ENCODER.encode(JSON.stringify(await val.text()));
			}
			return;
		}

		if (Array.isArray(val)) {
			yield symbols[LSB];

			if (val.length) {
				let j = 0;
				while(true) {
					yield *serialize(val[j]);
					if (++j === val.length) break;
					yield symbols[COMMA];
				}
			}

			yield symbols[RSB];
		} else if (val != null && typeof val === 'object') {
			yield symbols[LMB];

			const entries = Object.entries(val);
			if (entries.length) {
				let j = 0;
				while(true) {
					const [k, v] = entries[j++];
					if (v === undefined) continue;

					yield UTF8_TEXT_ENCODER.encode(JSON.stringify(k));
					yield symbols[COLON];
					yield *serialize(v, k);
					if (j === entries.length) break;
					yield symbols[COMMA];
				}
			}

			yield symbols[RMB];
		} else {
			yield UTF8_TEXT_ENCODER.encode(JSON.stringify(val));
		}
	}

	return serialize;
};
