import fs from "node:fs/promises";
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
	};

	DataView.prototype.getFloat16 = function (byteOffset, littleEndian = false) {
		fp16Tmp.setInt32(0, float16ToFloat32Bits(this.getUint16(byteOffset, littleEndian)));
		return fp16Tmp.getFloat32(0);
	};
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
	/** @type {Promise<void>} 初始化完成标记 */
	#ready;

	/** @type {Promise<void>} 写互斥锁，串行化所有磁盘写入 */
	#writeLock = Promise.resolve();

	/** @type {fs.FileHandle | null} */
	#handle = null;

	/** @type {boolean} */
	#faissReady = false;

	/** @type {any | null} faiss IndexIDMap 实例 */
	#faissIndex = null;

	/** @type {any | null} 缓存的 faiss-node 模块引用 */
	#faissModule = null;

	/** @type {Map<string, bigint>} */
	#idToFaissId = new Map();

	/** @type {Map<bigint, string>} */
	#faissIdToId = new Map();

	/** @type {bigint} */
	#faissIdCounter = 0n;

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
		this.pending = new Map();

		this.#ready = this.#init();
	}

	// ──── 生命周期 ────────────────────────────────────

	async close() {
		await this.#ready;
		if (this.#handle != null) {
			await this.#handle.close();
			this.#handle = null;
		}
		// 释放 faiss 索引（faiss-node 通常无需显式释放，但清引用帮助 GC）
		this.#faissIndex = null;
		this.#faissModule = null;
		this.#idToFaissId.clear();
		this.#faissIdToId.clear();
	}

	get size() {
		return this.index.size;
	}

	// ──── 初始化 ──────────────────────────────────────

	async #init() {
		this.#handle = await fs.open(this.filePath, 'a+');
		await this.#loadOrCreateFile();
		await this.#initFaiss();
	}

	/**
	 * 异步加载：扫描整个文件建立索引和空闲列表
	 */
	async #loadOrCreateFile() {
		/** @type {Buffer} */
		const buffer = await fs.readFile(this.filePath);
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
	 * 尝试加载 faiss-node 加速搜索。
	 * 失败则回退到暴力搜索（#faissIndex 保持 null）。
	 */
	async #initFaiss() {
		try {
			const faiss = await import('faiss-node');
			const IndexFlatIP = faiss.IndexFlatIP;
			const IndexIDMap = faiss.IndexIDMap;

			if (!IndexFlatIP || !IndexIDMap) {
				console.log('faiss-node: missing expected exports, using brute-force search');
				return;
			}

			const inner = new IndexFlatIP(this.dimension);
			this.#faissIndex = new IndexIDMap(inner);
			this.#faissModule = faiss;
			this.#idToFaissId = new Map();
			this.#faissIdToId = new Map();
			this.#faissIdCounter = 0n;

			// 将已有向量批量灌入 faiss
			if (this.index.size > 0) {
				const ids = new BigInt64Array(this.index.size);
				const vectors = new FloatArray(this.index.size * this.dimension);
				let i = 0;
				for (const [id, item] of this.index) {
					const faissId = this.#faissIdCounter++;
					this.#idToFaissId.set(id, faissId);
					this.#faissIdToId.set(faissId, id);
					ids[i] = faissId;
					vectors.set(item.vector, i * this.dimension);
					i++;
				}
				this.#faissIndex.addWithIds(vectors, ids);
			}

			this.#faissReady = true;
			console.log(`faiss-node: initialized with ${this.index.size} vectors`);
		} catch (e) {
			// 动态 import 失败（未安装）或 native 绑定加载失败，静默回退
			console.log(`faiss-node: not available, using brute-force search (${e.message})`);
			this.#faissIndex = null;
			this.#faissModule = null;
		}
	}

	// ──── 写互斥锁 ────────────────────────────────────

	/**
	 * 串行化异步写操作，防止竞态导致数据损坏。
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async #withWriteLock(fn) {
		const prev = this.#writeLock;
		let resolve;
		this.#writeLock = new Promise(r => { resolve = r; });
		await prev;
		try {
			return await fn();
		} finally {
			resolve();
		}
	}

	// ──── 公开 API ────────────────────────────────────

	/**
	 * 异步写入向量（从文本生成 embedding 后 upsert）。
	 * 若短时间内对同一 ID 多次调用，仅最后一次生效。
	 * @param {string} id
	 * @param {string} text
	 * @returns {Promise<void>}
	 */
	async set(id, text) {
		await this.#ready;
		const stamp = (this.pending.get(id) || 0) + 1;
		this.pending.set(id, stamp);

		try {
			const embedding = await getEmbedding(text);
			if (this.pending.get(id) === stamp) {
				this.pending.delete(id);
				return await this.upsert(id, embedding);
			}
		} catch (e) {
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
			throw e;
		}
	}

	/**
	 * 写入/更新向量（磁盘存 bf16，内存存 float32）。
	 * 在写锁内执行，确保 offset 分配与写入的原子性。
	 * @param {string} id
	 * @param {Float32Array | FloatArray} vector
	 * @returns {Promise<void>}
	 */
	async upsert(id, vector) {
		await this.#ready;
		return this.#withWriteLock(async () => {
			const floatVector = vector instanceof FloatArray ? vector : new FloatArray(vector);
			if (floatVector.length !== this.dimension) throw new Error("Dimension mismatch");

			const offset = this.index.get(id)?.offset
				?? this.freeSlots.shift()
				?? (await this.#handle.stat()).size;

			const buf = Buffer.alloc(this.recordSize);
			buf.write(id, 'utf8');

			const view = new DataView(buf.buffer, buf.byteOffset, this.dimension * 2);
			for (let i = 0; i < this.dimension; i++) {
				view.setFloat16(i * 2, floatVector[i]);
			}

			await this.#handle.write(buf, 0, buf.length, offset);
			this.index.set(id, { vector: floatVector, offset });
			await this.#faissUpsert(id, floatVector);
		});
	}

	/**
	 * 删除向量：将 ID 字段写零，回收槽位。
	 * @param {string} id
	 * @returns {Promise<void>}
	 */
	async delete(id) {
		await this.#ready;
		return this.#withWriteLock(async () => {
			const item = this.index.get(id);
			if (!item) return;

			const zeroes = Buffer.alloc(ID_LENGTH);
			await this.#handle.write(zeroes, 0, zeroes.length, item.offset);

			this.freeSlots.push(item.offset);
			this.index.delete(id);
			await this.#faissDelete(id);
		});
	}

	/**
	 * @param {string} text
	 * @param {number} topK
	 * @param {number} threshold
	 * @returns {Promise<{id: string, score: number}[]>}
	 */
	async query(text, topK, threshold) {
		await this.#ready;
		const emb = await getEmbedding(text);
		return this.search(emb, topK, threshold);
	}

	/**
	 * 搜索最相似的 topK 个向量。
	 * 优先使用 faiss 加速索引，不可用时回退到暴力搜索。
	 * @param {Float32Array} query
	 * @param {number} topK
	 * @param {number} threshold
	 * @returns {Promise<{id: string, score: number}[]>}
	 */
	async search(query, topK = 5, threshold = 0.3) {
		await this.#ready;

		// 尝试 faiss 搜索
		if (this.#faissReady && this.index.size > 0) {
			try {
				const vec = new FloatArray(query);
				const { distances, labels } = this.#faissIndex.search(vec, topK);

				const results = [];
				for (let i = 0; i < labels.length; i++) {
					const faissId = labels[i];
					const id = this.#faissIdToId.get(faissId);
					const score = distances[i];
					if (id && score > threshold) {
						results.push({ id, score });
					}
				}
				return results;
			} catch (e) {
				console.error('faiss search failed, falling back to brute-force:', e.message);
				// 回退到暴力搜索
			}
		}

		// 暴力搜索
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

	// ──── faiss 同步 ──────────────────────────────────

	/**
	 * 向 faiss 索引添加/更新向量。失败静默（不影响主流程）。
	 */
	async #faissUpsert(id, vector) {
		if (!this.#faissReady) return;

		try {
			// 移除旧条目
			const oldFaissId = this.#idToFaissId.get(id);
			if (oldFaissId !== undefined) {
				const IDSelectorBatch = this.#faissModule.IDSelectorBatch;
				if (IDSelectorBatch) {
					const selector = new IDSelectorBatch(new BigInt64Array([oldFaissId]));
					this.#faissIndex.removeIds(selector);
				}
				this.#faissIdToId.delete(oldFaissId);
			}

			// 添加新条目
			const faissId = this.#faissIdCounter++;
			this.#idToFaissId.set(id, faissId);
			this.#faissIdToId.set(faissId, id);

			const vec = new FloatArray(vector);
			this.#faissIndex.addWithIds(vec, new BigInt64Array([faissId]));
		} catch (e) {
			console.error(`faiss upsert failed for "${id}":`, e.message);
		}
	}

	/**
	 * 从 faiss 索引删除向量。失败静默。
	 */
	async #faissDelete(id) {
		if (!this.#faissReady) return;

		try {
			const faissId = this.#idToFaissId.get(id);
			if (faissId !== undefined) {
				const IDSelectorBatch = this.#faissModule.IDSelectorBatch;
				if (IDSelectorBatch) {
					const selector = new IDSelectorBatch(new BigInt64Array([faissId]));
					this.#faissIndex.removeIds(selector);
				}
				this.#idToFaissId.delete(id);
				this.#faissIdToId.delete(faissId);
			}
		} catch (e) {
			console.error(`faiss delete failed for "${id}":`, e.message);
		}
	}
}
