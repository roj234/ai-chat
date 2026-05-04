/**
 *
 * @param {ArrayBuffer} buff
 * @return {Record<string, string>}
 */
export function readPNG(buff) {
	const view = new DataView(buff);
	const data = new Uint8Array(buff);
	let offset = 8;
	const chunks = {};

	// 验证 PNG 文件头
	const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for (let i = 0; i < 8; i++) {
		if (data[i] !== magic[i]) throw "The input is not a PNG file!";
	}

	// 辅助函数：读取 ASCII 字符串
	const readASCII = (off, length) => {
		let str = "";
		for (let i = 0; i < length; i++) {
			str += String.fromCharCode(data[off + i]);
		}
		return str;
	};

	while (offset < data.length) {
		// 读取 Chunk 长度 (4字节, 大端)
		const len = view.getUint32(offset, false);
		offset += 4;

		// 读取 Chunk 类型 (4字节)
		const type = readASCII(offset, 4);
		offset += 4;

		if (type === "tEXt") {
			// 找到关键词结束的空字符 (0x00)
			let nz = offset;
			while (data[nz] !== 0 && nz < offset + len) nz++;

			const keyw = readASCII(offset, nz - offset);
			chunks[keyw] = readASCII(nz + 1, offset + len - nz - 1);
		}

		if (type === "IEND") break;

		// 跳过数据内容和 CRC (4字节)
		offset += len;
		offset += 4;
	}

	return chunks;
}