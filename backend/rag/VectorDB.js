import fs from "node:fs";
import {
	SEMANTIC_SEARCH_API_BASE,
	SEMANTIC_SEARCH_API_KEY,
	SEMANTIC_SEARCH_API_MODEL, SEMANTIC_SEARCH_CHUNK_MODE,
	SEMANTIC_SEARCH_EMBEDDING_SIZE
} from "../config.js";

/**
 *
 * @param {string} text
 * @return {Promise<Float32Array>}
 */
export async function getEmbedding(text) {
	if (text.length > SEMANTIC_SEARCH_CHUNK_MODE.length) {
		text = text.substring(0, SEMANTIC_SEARCH_CHUNK_MODE.length);
	}

	const response = await fetch(SEMANTIC_SEARCH_API_BASE, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer `+SEMANTIC_SEARCH_API_KEY
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
		this.vectorByteSize = dimension * 4;
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
				// 除去末尾可能的补全零，转回字符串作为 Key
				const id = idBuf.toString('utf8').replace(/\0/g, '');
				const vectorBuf = buffer.slice(offset + this.idByteSize, offset + this.recordSize);
				// 拷贝一份数据防止由于 Buffer 共享导致的内存问题
				const vector = new Float32Array(new Uint8Array(vectorBuf).buffer);
				this.index.set(id, { vector, offset });
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
			this.upsert(id, embedding);
		});
	}

	/**
	 * 写入/更新向量
	 */
	async upsert(id, vector) {
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

		const idBuf = this._formatId(id);
		const vectorBuf = Buffer.from(floatVector.buffer);
		const recordBuf = Buffer.concat([idBuf, vectorBuf]);

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

	query(text, topK = 5) {
		return getEmbedding(text).then(emb => this.search(emb, topK));
	}

	/**
	 * 搜索
	 */
	search(queryVector, topK = 5) {
		const qv = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);
		const results = [];

		for (const [id, item] of this.index) {
			let score = 0;
			const v = item.vector;
			for (let i = 0; i < this.dimension; i++) {
				score += qv[i] * v[i];
			}
			results.push({ id, score });
		}

		return results
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}
}