/**
 *
 * @param {Blob} blob
 * @return {Promise<[string, number]>}
 */
async function readBOM(blob) {
	const stream = blob.stream();
	const reader = stream.getReader();
	try {
		let totalRead = 0;
		const bom = new Uint8Array(4);

		while (totalRead < 4) {
			const { value, done } = await reader.read();
			if (done) break; // 文件提前结束（不足4字节）

			const remaining = 4 - totalRead;
			const slice = value.slice(0, remaining);
			bom.set(slice, totalRead);
			totalRead += slice.length;
		}

		switch (bom[0] & 0xFF) {
			case 0x00:
				if ((bom[1] === 0x00) && (bom[2] === 0xFE) && (bom[3] === 0xFF)) {
					return ["UTF-32BE", 4];
				}
				break;
			case 0xFF:
				if (bom[1] === 0xFE) {
					if ((bom[2] === 0x00) && (bom[3] === 0x00)) {
						return ["UTF-32LE", 4];
					} else {
						return ["UTF-16LE", 2];
					}
				}
				break;
			case 0xEF:
				if ((bom[1] === 0xBB) && (bom[2] === 0xBF)) {
					return ["UTF-8", 3];
				}
				break;
			case 0xFE:
				if ((bom[1] === 0xFF)) {
					return ["UTF-16BE", 2];
				}
				break;
			case 0x84:
				// ZWNBSP in GB18030
				if (bom[1] === 0x31 && (bom[2] === 0x95) && (bom[3] === 0x33)) {
					return ["GB18030", 4];
				}
			break;
		}

		return [,0];
	} finally {
		reader.releaseLock(); // 释放锁，其他读取器可复用
	}
}

/**
 *
 * @param {Blob} blob
 * @param {string} charset
 * @return {Promise<string>}
 */
async function tryDecode(blob, charset) {
	const stream = blob.stream().pipeThrough(new TextDecoderStream(charset, { fatal: true, ignoreBOM: true }));
	const reader = stream.getReader();

	let result = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += value;
	}

	return result;
}
/**
 *
 * @param {Blob} blob
 * @return {Promise<string>}
 */
export async function readAsString(blob) {
	const [charset, skip] = await readBOM(blob);

	if (charset) return await tryDecode(blob, charset);

	const utfVal = await tryDecode(blob, 'UTF-8').catch(_ => null);
	const gbkVal = await tryDecode(blob, 'GB18030').catch(_ => null);

	return utfVal || gbkVal;
}