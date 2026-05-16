import {createBase64Encoder} from "unconscious/common/Base64.js";

const isNode = !import.meta.env?.MODE;
const buffer = new Uint8Array([34,58,44,91,93,123,125]);
const symbols = Array.from({ length: 7 }).map((item, i) => buffer.subarray(i, i+1));
const QUOTE = 0, COLON = 1, COMMA = 2, LSB = 3, RSB = 4, LMB = 5, RMB = 6;

export const createJsonStream = (obj, useBlobProxy) => new ReadableStream({
	async start(controller) {
		for await (const chunk of createJsonSerializer(useBlobProxy)(obj)) {
			controller.enqueue(chunk);
		}
		controller.close();
	}
});

/**
 * 创建一个流式 JSON 序列化器。
 * @returns {(value: unknown) => AsyncGenerator<Uint8Array, void, void>} 一个异步生成器函数，接收任意值并逐步产出 JSON 字节块。
 */
export const createJsonSerializer = useBlobProxy => {
	const te = new TextEncoder();
	let be;

	async function* serialize(val) {
		const constructor = val?.constructor;
		if (!isNode && (constructor === Blob || constructor === File)) {
			const {name, type, size, hash} = val;
			const isTextFile = type.startsWith("text/") || type === "application/json";
			const isAudio = type.startsWith("audio/");

			if (size === 0) throw "文件"+name+"的数据不完整或已损坏。请尝试重新上传";
			/*if (hash && useBlobProxy && DB_MODE !== "local") {
				yield *serialize({
					$: "Blob"+(isTextFile? "Raw" : isAudio ? "RawDataURL" : "DataURL"),
					url: val.toUrl(),
					type
				});
				return;
			}*/

			if (isTextFile) {
				yield te.encode(JSON.stringify(await val.text()));
			} else {
				yield symbols[QUOTE];

				const reader = val.stream().getReader();

				if (!isAudio) {
					// dataUrl
					yield te.encode(`data:${val.type};base64,`);
				}

				if (!be) be = createBase64Encoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					yield *be.encode(value);
				}

				yield be.finish();
				yield symbols[QUOTE];
			}

		} else if (Array.isArray(val)) {
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

					yield te.encode(JSON.stringify(k));
					yield symbols[COLON];
					yield *serialize(v);
					if (j === entries.length) break;
					yield symbols[COMMA];
				}
			}

			yield symbols[RMB];
		} else {
			yield te.encode(JSON.stringify(val));
		}
	}

	return serialize;
};
