import {UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "unconscious";
import {crc32} from "unconscious/common/zip-io.js";

const magic = 0x89504e470d0a1a0an;

/**
 *
 * @param {Uint8Array} data
 * @param {boolean=} returnStripped
 * @return {Record<string, string> & {STRIPPED: Uint8Array}}
 */
export function readPNG(data, returnStripped) {
	const view = new DataView(data.buffer);
	if (view.getBigUint64(0) !== magic)
		throw "The input is not a PNG file!";

	let offset = 8;
	const texts = {};

	// 辅助函数：读取 ASCII 字符串
	const readASCII = (off, length) => {
		let str = "";
		for (let i = 0; i < length; i++) {
			str += String.fromCharCode(data[off + i]);
		}
		return str;
	};

	while (offset < data.length) {
		const len = view.getUint32(offset);
		offset += 4;
		const type = readASCII(offset, 4);
		offset += 4;

		if (type === "tEXt") {
			// 找到关键词结束的空字符 (0x00)
			let nz = offset;
			while (data[nz] !== 0 && nz < offset + len) nz++;

			const keyw = readASCII(offset, nz - offset);
			texts[keyw] = readASCII(nz + 1, offset + len - nz - 1);
		}

		if (type === "IEND") break;

		offset += len + 4;
	}

	if (returnStripped) {
		let offset = 8;
		const chunksToRemove = new Set(["tEXt", "zTXt", "iTXt"]);

		const outData = new Uint8Array(data.length);
		outData.set(data.subarray(0, 8));
		let outOffset = 8;

		while (offset < data.length) {
			const len = view.getUint32(offset, false);
			const type = readASCII(offset + 4, 4);
			const totalChunkLength = 12 + len;

			if (!chunksToRemove.has(type)) {
				outData.set(data.subarray(offset, offset + totalChunkLength), outOffset);
				outOffset += totalChunkLength;
			}

			offset += totalChunkLength;
			if (type === "IEND") break;
		}

		texts.STRIPPED = outData.subarray(0, outOffset);
	}

	return texts;
}

/**
 * Writes one or more text fields into a PNG buffer.
 * The new tEXt chunks are inserted just before the IEND chunk.
 *
 * @param {Uint8Array} data - Original PNG data (or a stripped PNG from readPNG).
 * @param {Record<string, string>} texts - Key/value pairs to embed as tEXt chunks.
 * @returns {Uint8Array} New PNG data containing the embedded text fields.
 */
export function writePNG(data, texts) {
	const view = new DataView(data.buffer);
	if (view.getBigUint64(0) !== magic)
		throw "The input is not a PNG file!";

	const chunks = [];
	let offset = 8;

	while (offset < data.length) {
		const length = view.getUint32(offset, false);
		const type = String.fromCharCode(
			data[offset + 4], data[offset + 5],
			data[offset + 6], data[offset + 7]
		);
		if (type === 'IEND') break;

		const totalChunkLength = 12 + length;
		offset += totalChunkLength;
	}
	chunks.push(data.subarray(0, offset));

	let length = 0;
	for (const [key, value] of Object.entries(texts)) {
		const keyBytes = UTF8_TEXT_ENCODER.encode(key);
		const valBytes = UTF8_TEXT_ENCODER.encode(value);

		// Chunk data: length + type + keyword + null + text + crc32
		const dataLength = 1 + keyBytes.length + valBytes.length;
		const totalLength = 12 + dataLength;
		const chunk = new Uint8Array(totalLength);
		const chunkView = new DataView(chunk.buffer);

		chunkView.setUint32(0, dataLength);
		chunkView.setUint32(4, 0x74455874);
		chunk.set(keyBytes, 8);
		chunk.set(valBytes, keyBytes.length + 9);

		const crc = crc32(chunk.subarray(4, chunk.length - 4));
		chunkView.setUint32(chunk.length - 4, crc);

		chunks.push(chunk);
		length += totalLength;
	}

	chunks.push(data.subarray(offset));

	const result = new Uint8Array(data.length + length);
	let pos = 0;
	for (const chunk of chunks) {
		result.set(chunk, pos);
		pos += chunk.length;
	}
	return result;
}

/**
 * 从 JPEG 字节中提取所有注释 (COM) 段的内容
 * @param {Uint8Array} data - JPEG 文件的原始字节
 * @param {boolean=} returnStripped
 * @returns {{comments: string[], STRIPPED?: Uint8Array}} 注释字符串数组（UTF-8 解码）
 */
export function readJPEG(data, returnStripped) {
	if (data[0] !== 0xFF || data[1] !== 0xD8 || data[2] !== 0xFF) throw 'Malformed JPEG';

	const hole = [];
	const comments = [];

	let offset = 2;
	while (offset < data.length) {
		if (data[offset] !== 0xFF) { offset++; continue; }
		const marker = data[offset + 1];

		if (marker === 0x00 || marker >= 0xD0 && marker <= 0xD7) { offset += 2; continue; }
		if (marker === 0xD9) break;

		if (!marker) throw 'Malformed JPEG';

		const len = (data[offset + 2] << 8) | data[offset + 3];
		const end = offset + 2 + len;
		if (len < 2 || end > data.length) throw 'Malformed JPEG';

		if (marker === 0xFE) {
			comments.push(UTF8_TEXT_DECODER.decode(data.subarray(offset + 4, offset + 4 + len - 2)));
			returnStripped && hole.push([offset, end]);
		}

		offset = end;
	}

	const obj = {comments};
	if (returnStripped) {
		const array = new Uint8Array(data.length);
		let i = 0, j = 0;
		for (const [start, end] of hole) {
			const seg = data.subarray(i, start);
			array.set(seg, j);
			i = end;
			j += seg.length;
		}
		const seg = data.subarray(i);
		array.set(seg, j);

		obj.STRIPPED = array.subarray(0, j + seg.length);
	}
	return obj;
}

/**
 * 向 JPEG 文件写入注释（覆盖或追加）
 * @param {Uint8Array} data - 原始 JPEG 字节
 * @param {string} comment - 要写入的注释内容
 * @returns {Uint8Array} 包含新注释的 JPEG 字节
 */
export function writeJPEG(data, comment) {
	const commentBytes = UTF8_TEXT_ENCODER.encode(comment);
	const MAX_PAYLOAD = 65533;
	const segments = [];
	let length = 0;
	for (let i = 0; i < commentBytes.length; i += MAX_PAYLOAD) {
		const chunk = commentBytes.subarray(i, i + MAX_PAYLOAD);

		const segLength = 2 + chunk.length;
		const segment = new Uint8Array(4 + chunk.length);
		segment[0] = 0xFF;
		segment[1] = 0xFE;
		segment[2] = (segLength >> 8);
		segment[3] = segLength;
		segment.set(chunk, 4);

		segments.push(segment);

		length += segment.length;
	}

	const newSize = data.length + length;
	const result = new Uint8Array(newSize);
	result.set([0xFF, 0xD8], 0); // SOI

	let off = 2;
	for (const seg of segments) {
		result.set(seg, off);
		off += seg.length;
	}

	result.set(data.subarray(2), off);
	return result;
}
