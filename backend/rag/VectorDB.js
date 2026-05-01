import fs from "node:fs";
import {
	SEMANTIC_SEARCH_API_BASE,
	SEMANTIC_SEARCH_API_KEY,
	SEMANTIC_SEARCH_API_MODEL,
	SEMANTIC_SEARCH_CHUNK_MODE,
	SEMANTIC_SEARCH_EMBEDDING_SIZE
} from "../config.js";
import {TopK} from "../utils/TopK.js";
import removeMd from "remove-markdown";

// ---------- bf16 转换工具 ----------

const bf16ConvTemp = new DataView(new ArrayBuffer(4));

/**
 * bf16 (16位) -> float32
 * @param {number} h - 16位无符号整数
 * @returns {number} IEEE 754 单精度浮点数
 */
function bf16ToFloat32(h) {
	const s = (h >> 15) & 0x1;
	const e = (h >> 7) & 0xFF;   // 8位指数
	const f = h & 0x7F;           // 7位尾数

	let bits;
	if (e === 0) {
		// 零或非规格化数
		if (f !== 0) {
			// 非规格化数：直接映射到 float32 的非规格化，尾数左移16位
			bits = (s << 31) | (e << 23) | (f << 16);
		} else {
			bits = s << 31;  // 有符号零
		}
	} else if (e === 0xFF) {
		// 无穷大或 NaN
		if (f === 0) {
			bits = (s << 31) | (0xFF << 23);           // 无穷大
		} else {
			bits = (s << 31) | (0xFF << 23) | (f << 16) | 1; // 静默 NaN，确保不是无穷大
		}
	} else {
		// 正常数：指数相同，尾数左移16位
		bits = (s << 31) | (e << 23) | (f << 16);
	}

	bf16ConvTemp.setInt32(0, bits);
	return bf16ConvTemp.getFloat32(0);
}

/**
 * float32 -> bf16 (返回16位整数)
 * 舍入方式：就近舍入，偶数优先
 * @param {number} value
 * @returns {number} 16位无符号整数
 */
function float32ToBf16(value) {
	if (isNaN(value)) return 0x7FC0;

	bf16ConvTemp.setFloat32(0, value);
	let bits = bf16ConvTemp.getInt32(0);

	const s = (bits >>> 31) & 1;
	let e = (bits >>> 23) & 0xFF;
	const f = bits & 0x7FFFFF;

	// 无穷大或 NaN
	if (e === 0xFF) {
		if (f !== 0) {
			// NaN：保留尾数高7位，并确保非零
			const bf16F = (f >> 16) | 1;
			return (s << 15) | (0xFF << 7) | bf16F;
		}
		return (s << 15) | (0xFF << 7); // 无穷大
	}

	// 非规格化数 (e == 0)
	if (e === 0) {
		if (f === 0) return s << 15; // 零
		// 简单截断 + 舍入
		const bf16F = f >> 16;
		const roundBit = (f >> 15) & 1;
		const remainder = f & 0x7FFF;
		let bf16Bits = (s << 15) | (bf16F & 0x7F);
		if (roundBit && (remainder > 0 || (bf16F & 1))) {
			bf16Bits += 1;
		}
		return bf16Bits & 0xFFFF;
	}

	// 正常数
	const bf16F = f >> 16;
	const roundBit = (f >> 15) & 1;
	const remainder = f & 0x7FFF;
	let bf16Bits = (s << 15) | (e << 7) | bf16F;
	if (roundBit && (remainder > 0 || (bf16F & 1))) {
		bf16Bits += 1;
	}
	return bf16Bits & 0xFFFF;
}

// ---------- 原业务代码（已修改为 bf16 存储） ----------

/**
 * @param {string} text
 * @return {Promise<Float32Array>}
 */
export async function getEmbedding(text) {
	text = removeMd(text);
	if (text.length > SEMANTIC_SEARCH_CHUNK_MODE.length) {
		text = text.substring(0, SEMANTIC_SEARCH_CHUNK_MODE.length);
	}

	const response = await fetch(SEMANTIC_SEARCH_API_BASE, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ` + SEMANTIC_SEARCH_API_KEY
		},
		body: JSON.stringify({
			model: SEMANTIC_SEARCH_API_MODEL,
			input: text
		})
	});
	if (!response.ok) throw new Error(await response.text());

	const result = await response.json();
	return new Float32Array(result.data[0].embedding);
}

export class VectorDB {
	/**
	 * @param {string} filePath 文件路径
	 * @param {number} dimension 向量维度
	 */
	constructor(filePath, dimension = SEMANTIC_SEARCH_EMBEDDING_SIZE) {
		this.filePath = filePath;
		this.dimension = dimension;
		this.idByteSize = 16;
		this.vectorByteSize = dimension * 2; // bf16
		this.recordSize = this.idByteSize + this.vectorByteSize;

		// 内存索引：id -> { vector: Float32Array, offset: number }
		this.index = new Map();
		// 维护一个空闲槽位队列 (文件偏移量)
		this.freeSlots = [];

		this._loadOrCreateFile();
	}

	get size() {
		return this.index.size;
	}

	/**
	 * 初始化加载：扫描整个文件建立索引和空闲列表
	 */
	_loadOrCreateFile() {
		if (!fs.existsSync(this.filePath)) {
			fs.writeFileSync(this.filePath, Buffer.alloc(0));
			return;
		}

		const buffer = fs.readFileSync(this.filePath);
		let offset = 0;

		while (offset + this.recordSize <= buffer.length) {
			const idBuf = buffer.slice(offset, offset + this.idByteSize);

			// 检查是否全零（标记删除）
			const isEmpty = idBuf.every(byte => byte === 0);

			if (isEmpty) {
				this.freeSlots.push(offset);
			} else {
				// 去除末尾可能的零，转回字符串作为 Key
				const id = idBuf.toString('utf8').replace(/\0/g, '');
				// 读取 bf16 向量并转换为 Float32Array
				const view = new DataView(buffer.buffer, offset + this.idByteSize, this.vectorByteSize);
				const floatVec = new Float32Array(this.dimension);
				for (let i = 0; i < this.dimension; i++) {
					const h = view.getUint16(i * 2);
					floatVec[i] = bf16ToFloat32(h);
				}
				this.index.set(id, { vector: floatVec, offset });
			}
			offset += this.recordSize;
		}
		console.log(`Loaded ${this.index.size} vectors, Found ${this.freeSlots.length} free slots.`);
	}

	/**
	 * 将 ID 转换为 16 字节的 Buffer
	 */
	_formatId(id) {
		const buf = Buffer.alloc(this.idByteSize, 0);
		buf.write(id, 'utf8');
		return buf;
	}

	/**
	 *
	 * @param {string} id
	 * @param {string} text
	 */
	set(id, text) {
		// TODO 在这里做版本机制，只保留最新的
		return getEmbedding(text).then(embedding => {
			return this.upsert(id, embedding);
		});
	}

	/**
	 * 写入/更新向量（磁盘存 bf16，内存存 float32）
	 */
	upsert(id, vector) {
		const floatVector = vector instanceof Float32Array ? vector : new Float32Array(vector);
		if (floatVector.length !== this.dimension) throw new Error("Dimension mismatch");

		let offset;
		const existing = this.index.get(id);

		if (existing) {
			// 1. 如果已存在，原地覆盖
			offset = existing.offset;
		} else if (this.freeSlots.length > 0) {
			// 2. 优先使用空闲槽位
			offset = this.freeSlots.shift();
		} else {
			// 3. 尾部追加
			const stats = fs.statSync(this.filePath);
			offset = stats.size;
		}

		// 将 Float32Array 转换为 bf16 字节序列
		const bf16Buf = Buffer.alloc(this.vectorByteSize);
		for (let i = 0; i < this.dimension; i++) {
			const h = float32ToBf16(floatVector[i]);
			bf16Buf.writeUInt16BE(h, i * 2);
		}

		const idBuf = this._formatId(id);
		const recordBuf = Buffer.concat([idBuf, bf16Buf]);

		// 执行文件随机写
		const fd = fs.openSync(this.filePath, 'r+');
		fs.writeSync(fd, recordBuf, 0, this.recordSize, offset);
		fs.closeSync(fd);

		// 更新内存索引
		this.index.set(id, { vector: floatVector, offset });
	}

	/**
	 * 删除向量：标记槽位为空
	 */
	async delete(id) {
		const item = this.index.get(id);
		if (!item) return;

		// 将 ID 部分填全零
		const emptyId = Buffer.alloc(this.idByteSize, 0);

		const fd = fs.openSync(this.filePath, 'r+');
		fs.writeSync(fd, emptyId, 0, this.idByteSize, item.offset);
		fs.closeSync(fd);

		// 更新状态
		this.freeSlots.push(item.offset);
		this.index.delete(id);
	}

	query(text, topK, threshold) {
		return getEmbedding(text).then(emb => this.search(emb, topK, threshold));
	}

	/**
	 * 搜索
	 * @param {Float32Array} query
	 * @param {number} topK
	 * @param {number} threshold
	 */
	search(query, topK = 5, threshold = 0.3) {
		const array = new TopK(topK, (l, r) => r.score - l.score);
		for (const [id, item] of this.index) {
			let score = 0;
			const v = item.vector;
			for (let i = 0; i < this.dimension; i++) {
				score += query[i] * v[i];
			}
			if (score > threshold)
				array.add({ id, score });
		}

		return array.toArray();
	}
}