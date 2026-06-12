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
import {float16ToFloat32Bits, float32ToFloat16Bits} from "./fp16.js";

const ID_LENGTH = 16;
const FloatArray = global.Float16Array || global.Float32Array;

// Polyfill
if (!DataView.prototype.setFloat16) {
	const fp16Tmp = new DataView(new ArrayBuffer(4));

	DataView.prototype.setFloat16 = function (byteOffset, value, littleEndian = false) {
		fp16Tmp.setFloat32(0, value);
		this.setUint16(byteOffset, float32ToFloat16Bits(fp16Tmp.getUint32(0)), littleEndian);
	}

	DataView.prototype.getFloat16 = function (byteOffset, littleEndian = false) {
		fp16Tmp.setInt32(0, float16ToFloat32Bits(this.getUint16(byteOffset, littleEndian)));
		return fp16Tmp.getFloat32(0);
	}
}
/**
 * 根据配置截取文本
 * @param {string} text 原始文本
 * @returns {string} 处理后的文本
 */
function chunkText(text) {
	const { type, length } = SEMANTIC_SEARCH_CHUNK_MODE;

	// 如果文本长度未超限，直接返回
	if (text.length <= length) return text;

	if (type === "head-tail") {
		// 头尾模式：取前一半和后一半
		const half = Math.floor(length / 2);
		const head = text.slice(0, half);
		const tail = text.slice(text.length - half);
		return head + "\n...\n" + tail;
	} else {
		// 默认 head 模式：只取开头
		return text.slice(0, length);
	}
}

/**
 * @param {string} text
 * @return {Promise<Float32Array>}
 */
export async function getEmbedding(text) {
	text = removeMd(text);
	text = chunkText(text);

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
	return new FloatArray(result.data[0].embedding);
}

export class VectorDB {
	/**
	 * @param {string} filePath 文件路径
	 * @param {number} dimension 向量维度
	 */
	constructor(filePath, dimension = SEMANTIC_SEARCH_EMBEDDING_SIZE) {
		this.filePath = filePath;
		this.dimension = dimension;
		this.recordSize = ID_LENGTH + dimension * 2; // bf16

		// 内存索引：id -> { vector: Float32Array, offset: number }
		this.index = new Map();
		// 维护一个空闲槽位队列 (文件偏移量)
		this.freeSlots = [];

		// 版本号机制
		this.pending = new Map;

		this.fd = fs.openSync(this.filePath, 'a+');
		this._loadOrCreateFile();
	}

	close() {
		if (this.fd != null) fs.closeSync(this.fd);
		this.fd = null;
	}

	get size() {
		return this.index.size;
	}

	/**
	 * 初始化加载：扫描整个文件建立索引和空闲列表
	 */
	_loadOrCreateFile() {
		/** @type {Buffer} */
		const buffer = fs.readFileSync(this.filePath);
		let offset = 0;

		while (offset + this.recordSize <= buffer.length) {
			const id = buffer.toString('utf8', offset, offset + ID_LENGTH).replace(/\0/g, '');
			if (!id) {
				this.freeSlots.push(offset);
			} else {
				const vector = new FloatArray(this.dimension);
				const view = new DataView(buffer.buffer, buffer.byteOffset + offset + ID_LENGTH, this.dimension * 2);
				for (let i = 0; i < this.dimension; i++) vector[i] = view.getFloat16(i * 2);
				this.index.set(id, { vector, offset });
			}
			offset += this.recordSize;
		}
		console.log(`Loaded ${this.index.size} vectors, Found ${this.freeSlots.length} free slots.`);
	}

	/**
	 *
	 * @param {string} id
	 * @param {string} text
	 */
	set(id, text) {
		const stamp = (this.pending.get(id) || 0) + 1;
		this.pending.set(id, stamp);

		return getEmbedding(text).then(embedding => {
			if (this.pending.get(id) === stamp) {
				this.pending.delete(id);
				return this.upsert(id, embedding);
			}
		}).catch(e => {
			if (this.pending.get(id) === stamp) {
				this.pending.delete(id);
				console.error("Embedding生成失败");
				if (e.message === "fetch failed") {
					e = e.cause;
				}
				if (e.code === "ECONNREFUSED") {
					console.error("与Embedding API的连接未成功，请检查API地址");
				} else {
					console.error(e);
				}
			}
		});
	}

	/**
	 * 写入/更新向量（磁盘存 bf16，内存存 float32）
	 */
	upsert(id, vector) {
		const floatVector = vector instanceof FloatArray ? vector : new FloatArray(vector);
		if (floatVector.length !== this.dimension) throw new Error("Dimension mismatch");

		const offset = this.index.get(id)?.offset ?? this.freeSlots.shift() ?? fs.statSync(this.filePath).size;

		const buf = Buffer.alloc(this.recordSize);
		buf.write(id, 'utf8');

		const view = new DataView(buf.buffer, buf.byteOffset, ID_LENGTH);
		for (let i = 0; i < this.dimension; i++) {
			view.setFloat16(i * 2, floatVector[i]);
		}

		fs.writeSync(this.fd, buf, 0, buf.length, offset);
		this.index.set(id, { vector: floatVector, offset });
	}

	/**
	 * 删除向量：标记槽位为空
	 */
	delete(id) {
		const item = this.index.get(id);
		if (!item) return;

		const zeroes = Buffer.alloc(ID_LENGTH);
		fs.writeSync(this.fd, zeroes, 0, zeroes.length, item.offset);

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