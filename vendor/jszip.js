
const CRC32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) {
		c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
	}
	CRC32[i] = c;
}

// 计算 CRC32
export function crc32(data) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		crc = (crc >>> 8) ^ CRC32[(crc ^ data[i]) & 0xFF];
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 将 JS Date 转换为 MS-DOS 时间格式
function getDosTime(date) {
	const y = date.getFullYear();
	const m = date.getMonth() + 1;
	const d = date.getDate();
	const hh = date.getHours();
	const mm = date.getMinutes();
	const ss = date.getSeconds();

	const datePart = ((y - 1980) << 9) | (m << 5) | d;
	const timePart = (hh << 11) | (mm << 5) | (ss >> 1);
	return { date: datePart, time: timePart };
}

/**
 * 辅助函数：使用 CompressionStream 压缩数据
 */
async function compressData(data) {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	const response = new Response(stream);
	return new Uint8Array(await response.arrayBuffer());
}

export function ZipWriter() {
	let offset = 0;
	let cenSize = 0;
	const locs = [];
	const cens = [];

	return {
		fileCount() {
			return cens.length / 2;
		},

		/**
		 * 添加文件
		 * @param {string} name 文件名
		 * @param {Uint8Array|string} content 内容
		 * @param {number=} timestamp 修改时间
		 * @param {boolean=false} compress 是否Deflate压缩
		 */
		async add(name, content, {timestamp, compress = false} = {}) {
			const encoder = new TextEncoder();
			const nameData = encoder.encode(name);
			const fileData = typeof content === 'string' ? encoder.encode(content) : content;
			const crc = crc32(fileData);
			const { time, date } = getDosTime(new Date(timestamp));
			const size = fileData.length;

			// 处理压缩
			let finalData = fileData;
			let compressionMethod = 0; // 0 = Store
			if (compress) {
				finalData = await compressData(fileData);
				compressionMethod = 8; // 8 = Deflate
			}
			const compressedSize = finalData.length;

			// LOC parts
			{
				const buffer = new ArrayBuffer(30);
				const view = new DataView(buffer);
				let p = 0;

				view.setUint32(p, 0x04034b50, true); p += 4;
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 2048, true); p += 2;  // General purpose bit flag
				view.setUint16(p, compressionMethod, true); p += 2; // compression
				view.setUint16(p, time, true); p += 2;
				view.setUint16(p, date, true); p += 2;
				view.setUint32(p, crc, true); p += 4;
				view.setUint32(p, compressedSize, true); p += 4;     // Compressed size
				view.setUint32(p, size, true); p += 4;     // Uncompressed size
				view.setUint16(p, nameData.length, true); p += 2;
				p += 2;          // Extra field length

				locs.push(buffer);
				locs.push(nameData);
				locs.push(finalData);
			}

			// CEN parts
			{
				const buffer = new ArrayBuffer(46);
				const view = new DataView(buffer);
				let p = 0;

				view.setUint32(p, 0x02014b50, true); p += 4; // Signature
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 2048, true); p += 2;
				view.setUint16(p, compressionMethod, true); p += 2;
				view.setUint16(p, time, true); p += 2;
				view.setUint16(p, date, true); p += 2;
				view.setUint32(p, crc, true); p += 4;
				view.setUint32(p, compressedSize, true); p += 4;
				view.setUint32(p, size, true); p += 4;
				view.setUint16(p, nameData.length, true); p += 2;
				p += 2;          // Extra length
				p += 2;          // Comment length
				p += 2;          // Disk number start
				p += 2;          // Internal attr
				p += 4;          // External attr
				view.setUint32(p, offset, true); p += 4; // Offset to local header

				cens.push(buffer);
				cens.push(nameData);

				cenSize += 46 + nameData.length;
			}

			offset += 30 + nameData.length + finalData.length;
		},

		finish() {
			const cenStart = offset;
			const cenEnd = offset + cenSize;
			const entriesCount = cens.length / 2;

			const buffer = new ArrayBuffer(22);
			const view = new DataView(buffer);
			let p = 0;

			// 4. End of central directory record (EOCD)
			view.setUint32(p, 0x06054b50, true); p += 4;
			p += 2; // Disk number
			p += 2; // Central dir disk
			view.setUint16(p, entriesCount, true); p += 2; // Total entries this disk
			view.setUint16(p, entriesCount, true); p += 2; // Total entries total
			view.setUint32(p, cenEnd - cenStart, true); p += 4; // Size of central dir
			view.setUint32(p, cenStart, true); p += 4; // Offset to central dir
			view.setUint16(p, 0, true); p += 2; // Comment length

			return new Blob([...locs, ...cens, buffer], { type: 'application/zip' });
		}
	}
}

/**
 * 将 MS-DOS 时间格式转换为 JS Date
 */
function parseDosTime(datePart, timePart) {
	const y = ((datePart >> 9) & 0x7F) + 1980;
	const m = (datePart >> 5) & 0x0F;
	const d = datePart & 0x1F;
	const hh = (timePart >> 11) & 0x1F;
	const mm = (timePart >> 5) & 0x3F;
	const ss = (timePart & 0x1F) << 1;
	return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * 使用 DecompressionStream 解压数据
 * 支持输入 Blob 或 ArrayBuffer
 */
async function decompressData(data) {
	const blob = data instanceof Blob ? data : new Blob([data]);
	const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const response = new Response(stream);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {Blob} blob
 */
export async function openZip(blob) {
	if (!(blob instanceof Blob)) throw new Error("Input must be Blob");
	const entries = new Map();
	const td = new TextDecoder();

	/**
	 * 读取指定范围的小段数据并返回 DataView
	 */
	async function _readChunk(offset, size) {
		const slice = blob.slice(offset, offset + size);
		const buffer = await slice.arrayBuffer();
		return {
			view: new DataView(buffer),
			bytes: new Uint8Array(buffer)
		};
	}

	/**
	 * @type {number}
	 */
	let eocdOffset, entryCount, centralDirOffset, centralDirSize;

	findEOCD: {
		const size = blob.size;
		// EOCD 最小 22 字节，注释最大 65535 字节
		const maxSearch = Math.min(size, 65535 + 22);
		const startPos = size - maxSearch;

		const { view, bytes } = await _readChunk(startPos, maxSearch);

		for (let i = bytes.length - 22; i >= 0; i--) {
			if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
				const commentLen = view.getUint16(i + 20, true);
				if (startPos + i + 22 + commentLen === size) {
					eocdOffset = startPos + i;
					entryCount = view.getUint16(i + 10, true);
					centralDirSize = view.getUint32(i + 12, true);
					centralDirOffset = view.getUint32(i + 16, true);
					break findEOCD;
				}
			}
		}

		throw new Error("Not a valid ZIP file (EOCD not found)");
	}

	// 处理 Zip64
	checkZip64:
	if (entryCount === 0xFFFF || centralDirOffset === 0xFFFFFFFF || centralDirSize === 0xFFFFFFFF) {
		const locatorPos = eocdOffset - 20;
		if (locatorPos < 0) break checkZip64;

		const { view } = await _readChunk(locatorPos, 20);
		if (view.getUint32(0, true) !== 0x07064b50) break checkZip64;

		const zip64EocdPos = Number(view.getBigUint64(8, true));
		const { view: z64View } = await _readChunk(zip64EocdPos, 56);

		if (z64View.getUint32(0, true) !== 0x06064b50) break checkZip64;

		entryCount = Number(z64View.getBigUint64(32, true));
		centralDirSize = Number(z64View.getBigUint64(40, true));
		centralDirOffset = Number(z64View.getBigUint64(48, true));
	}

	const { view, bytes } = await _readChunk(Number(centralDirOffset), Number(centralDirSize));

	let p = 0;
	for (let i = 0; i < entryCount; i++) {
		if (p + 46 > bytes.length) break;

		const sig = view.getUint32(p, true);
		if (sig !== 0x02014b50) break;

		const method = view.getUint16(p + 10, true);
		const time = view.getUint16(p + 12, true);
		const date = view.getUint16(p + 14, true);
		const crc = view.getUint32(p + 16, true);
		const compressedSize = view.getUint32(p + 20, true);
		const uncompressedSize = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localHeaderOffset = view.getUint32(p + 42, true);

		const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
		if (entries.has(name)) throw new Error("Duplicate filename "+name);

		entries.set(name, {
			method,
			crc,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			lastModified: parseDosTime(date, time)
		});

		p += 46 + nameLen + extraLen + commentLen;
	}

	return {
		async getText(name) {
			const data = await this.get(name);
			if (!data) return;
			return td.decode(data);
		},

		async getRaw(entry) {
			// 读取 Local Header 来确定确切的数据起始位置
			// Local Header 定长 30 字节，后面跟着变长的文件名和额外字段
			const { view: locView } = await _readChunk(entry.localHeaderOffset, 30);
			if (locView.getUint32(0, true) !== 0x04034b50) throw new Error("Invalid Local Header signature");

			const locNameLen = locView.getUint16(26, true);
			const locExtraLen = locView.getUint16(28, true);
			const dataStart = entry.localHeaderOffset + 30 + locNameLen + locExtraLen;

			// 仅对该文件的数据部分进行 slice
			return blob.slice(dataStart, dataStart + entry.compressedSize);
		},

		/**
		 * 获取文件内容并解压，不验证CRC32
		 * @return Promise<Uint8Array>
		 */
		async get(name) {
			const entry = entries.get(name);
			if (!entry) return null;

			const rawData = this.getRaw(entry);

			if (entry.method === 8) { // Deflate
				return await decompressData(rawData);
			} else if (entry.method === 0) { // Store
				return new Uint8Array(await rawData.arrayBuffer());
			} else {
				throw new Error(`Unsupported compression method: ${entry.method}`);
			}
		},

		entries() {return entries;}
	}
}
