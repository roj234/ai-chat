import {UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "unconscious";
import {crc32} from "unconscious/common/zip-io.js";

const magic = 0x89504e470d0a1a0an;

/**
 *
 * @param {Blob | Uint8Array} blob
 * @param {boolean} [options.text]
 * @param {boolean} [options.strip]
 */
export async function parseImageMeta(blob, options = {}) {
	let bytes = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.slice(0, 64).arrayBuffer());
	if (bytes.length < 16) return;
	let view = new DataView(bytes.buffer);

	if (view.getBigUint64(0) === magic) return parsePNG(bytes, view, options);
	if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
		return parseJPEG(blob, view, options);
	}
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return parseGIF(bytes, view, options);
	if (bytes[0] === 0x42 && bytes[1] === 0x4D) return parseBMP(bytes, view, options);

	if (
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		return parseWEBP(bytes, view, options);
	}
}

/**
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {Object} options
 * @return {{width: number, type: string, height: number}}
 */
function parseGIF(bytes, view, options) {
	const width = view.getUint16(6, true);
	const height = view.getUint16(8, true);
	return {type: 'gif', width, height};
}

/**
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {Object} options
 * @return {{width, type: string, height: number}}
 */
function parseBMP(bytes, view, options) {
	const dibSize = view.getUint32(14, true);
	let width, height;

	if (dibSize === 12 || dibSize === 16) {
		// BITMAPCOREHEADER
		width = view.getUint16(18, true);
		height = view.getUint16(20, true);
	} else {
		// BITMAPINFOHEADER
		width = view.getInt32(18, true);
		height = view.getInt32(22, true);
		if (height < 0) height = -height;
	}

	return { width, height, type: 'bmp' };
}

const readUint24LE = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

/**
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {Object} options
 * @return {{width, type: string, height: number}}
 */
function parseWEBP(bytes, view, options) {
	const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

	if (chunkType === 'VP8 ') {
		const width = view.getUint16(26, true) & 0x3FFF;
		const height = view.getUint16(28, true) & 0x3FFF;
		return { width, height, type: 'webp' };
	}

	if (chunkType === 'VP8L') {
		const v = view.getUint32(21, true);
		const width = (v & 0x3FFF) + 1;
		const height = ((v >> 14) & 0x3FFF) + 1;
		return { width, height, type: 'webp' };
	}

	if (chunkType === 'VP8X') {
		const width = readUint24LE(bytes, 24) + 1;
		const height = readUint24LE(bytes, 27) + 1;
		return { width, height, type: 'webp' };
	}
}

/**
 *
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {Object} options
 * @return {{width, type: string, height: number}}
 */
function parsePNG(bytes, view, {text, strip}) {
	let offset = 8;

	const width = view.getUint32(16);
	const height = view.getUint32(20);

	const metadata = {
		type: 'png',
		width,
		height
	};

	if (!strip && !text) return metadata;

	const texts  = metadata.texts = {};

	// 辅助函数：读取 ASCII 字符串
	const readASCII = (off, length) => {
		let str = "";
		for (let i = 0; i < length; i++) {
			str += String.fromCharCode(bytes[off + i]);
		}
		return str;
	};

	while (offset < bytes.length) {
		const len = view.getUint32(offset);
		offset += 4;
		const type = readASCII(offset, 4);
		offset += 4;

		if (type === "tEXt") {
			// 找到关键词结束的空字符 (0x00)
			let nz = offset;
			while (bytes[nz] !== 0 && nz < offset + len) nz++;

			const keyw = readASCII(offset, nz - offset);
			texts[keyw] = readASCII(nz + 1, offset + len - nz - 1);
		}

		if (type === "IEND") break;

		offset += len + 4;
	}

	if (strip) {
		let offset = 8;
		const chunksToRemove = new Set(["tEXt", "zTXt", "iTXt"]);

		const outData = new Uint8Array(bytes.length);
		outData.set(bytes.subarray(0, 8));
		let outOffset = 8;

		while (offset < bytes.length) {
			const len = view.getUint32(offset, false);
			const type = readASCII(offset + 4, 4);
			const totalChunkLength = 12 + len;

			if (!chunksToRemove.has(type)) {
				outData.set(bytes.subarray(offset, offset + totalChunkLength), outOffset);
				outOffset += totalChunkLength;
			}

			offset += totalChunkLength;
			if (type === "IEND") break;
		}

		metadata.strip = outData.subarray(0, outOffset);
	}

	return metadata;
}

/**
 * 从 JPEG 字节中提取所有注释 (COM) 段的内容
 * @param {Blob | Uint8Array} blob
 * @param {DataView} view
 * @param {Object} options
 * @return {{width, type: string, height: number}}
 */
async function parseJPEG(blob, view, {text, strip}) {
	let bytes;
	let ensureReadable;
	if (blob instanceof Uint8Array) {
		bytes = blob;
		ensureReadable = () => {};
	} else {
		ensureReadable = (desiredLength) => {
			const length = bytes?.length || 0;
			if (length >= desiredLength) return;

			const newSize = Math.min(Math.max(desiredLength, length << 1), blob.size);
			if (newSize === length) return;

			return blob.slice(0, newSize).arrayBuffer().then(ab => {
				bytes = new Uint8Array(ab);
				view = new DataView(ab);
			})
		};
		await ensureReadable(1024);
	}

	const earlyStop = !text && !strip;

	const hole = [];
	const comments = [];
	const metadata = {comments};

	let offset = 2;
	while (offset < bytes.length) {
		await ensureReadable(offset + 128);

		if (bytes[offset] !== 0xFF) { offset++; continue; }
		const marker = bytes[offset + 1];

		if (marker === 0x00 || marker >= 0xD0 && marker <= 0xD7) { offset += 2; continue; }
		if (marker === 0xD9) break;

		if (!marker) throw 'Malformed JPEG';

		const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
		const end = offset + 2 + len;
		await ensureReadable(end + 1);
		if (len < 2 || end > bytes.length) throw 'Malformed JPEG';

		if (marker === 0xFE) {
			comments.push(UTF8_TEXT_DECODER.decode(bytes.subarray(offset + 4, offset + 4 + len - 2)));
			strip && hole.push([offset, end]);
		}

		if (marker >= 0xC0 && marker <= 0xCF) {
			const height = view.getUint16(offset + 5);
			const width = view.getUint16(offset + 7);
			metadata.type = 'jpeg';
			metadata.width = width;
			metadata.height = height;
			if (earlyStop) return metadata;
		}

		offset = end;
	}

	if (!metadata.type) throw "No SOF found in JPEG";

	if (strip) {
		const array = new Uint8Array(bytes.length);
		let i = 0, j = 0;
		for (const [start, end] of hole) {
			const seg = bytes.subarray(i, start);
			array.set(seg, j);
			i = end;
			j += seg.length;
		}
		const seg = bytes.subarray(i);
		array.set(seg, j);

		metadata.strip = array.subarray(0, j + seg.length);
	}
	return metadata;
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
 * 向 JPEG 文件写入注释
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

export function limitMaxSide(width, height, maxSide) {
	if (width > maxSide || height > maxSide) {
		if (width > height) {
			height = (height / width) * maxSide;
			width = maxSide;
		} else {
			width = (width / height) * maxSide;
			height = maxSide;
		}
	}
	return [width, height];
}

/**
 * 压缩图片
 * @param {Blob} blob - 输入的原始图片文件
 * @param {Partial<AiChat.ModelConfig>} cfg
 * @returns {Promise<Blob>} - 返回压缩后的 JPEG Blob
 */
export const compressImage = async (blob, cfg) => {
	let quality = 0.85;
	const maxSide = cfg.imageLongLimit;
	const maxSize = Math.round(cfg.imageSizeLimit * 1048576);

	let {width, height} = await parseImageMeta(blob);
	if (width <= maxSide && height <= maxSide && blob.size <= maxSize) return blob;

	[width, height] = limitMaxSide(width, height, maxSide);

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#FFFFFF';
	ctx.fillRect(0, 0, width, height);

	const imageBitmap = await createImageBitmap(blob);
	ctx.drawImage(imageBitmap, 0, 0, width, height);
	imageBitmap.close();

	for (; ;) {
		let result = await canvas.convertToBlob({
			type: 'image/jpeg',
			quality
		});

		if (result.size <= maxSize || quality <= 0.5) return result;

		quality -= 0.05;
	}
};