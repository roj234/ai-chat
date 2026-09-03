import fs from 'node:fs/promises';
import {LRUCache} from "../../../common/LRUCache.js";
import {Readable} from "node:stream";
import {createWriteStream} from 'node:fs';

export const ROW_SIZE = 16;
export const HEADER_SIZE = ROW_SIZE;
export const NULL_OWNER = 0;
export const MAGIC_LOGD = 'TSD1';
export const MAGIC_LOGT = 'WAL1';
export const MAX_DATA_LEN = 255;

const MAX_U48 = 0xffffffffffff;
// 2023-01-01 UTC, LLM大范围应用之前。
// 这个值有几十年，足够我哪天想换
const TIME_BASE = 0;//1672531200000;

/**
 * 从 `buf` 的 `offset` 处解码一条 16 字节 RowMeta。
 *
 * @param {Buffer} buf 缓冲区
 * @param {number} [offset=0] 读取起始偏移
 * @returns {{time: number, owner: number, off: number, len: number}} 解码后的行元数据
 */
export function decodeRow(buf, offset = 0) {
	const time = buf.readUInt16BE(offset) * 0x100000000 + buf.readUInt32BE(offset + 2);
	const owner = buf.readUInt32BE(offset + 6);
	const off = buf.readUInt8(offset + 10) * 0x100000000 + buf.readUInt32BE(offset + 11);
	const len = buf.readUInt8(offset + 15);
	return { time : time + TIME_BASE, owner, off, len };
}

/**
 *
 * @param {FileHandle} wal
 * @return {Promise<LogItem[]>}
 */
async function readWAL(wal) {
	const size = (await wal.stat()).size;

	const hdr = Buffer.allocUnsafe(ROW_SIZE);
	await wal.read(hdr);
	if (hdr.toString('ascii', 0, 4) !== MAGIC_LOGT) throw new Error('db.wal: magic mismatch');

	const n = hdr.readUInt32BE(4);
	if (n > 65535) throw new Error("db.wal: rows too large " + n);

	const rowBuf = Buffer.allocUnsafe(n * ROW_SIZE);
	if ((await wal.read(rowBuf)).bytesRead < rowBuf.length) throw new Error("db.wal: truncated, no "+n+" rows.");

	const rows = Array(n);
	for (let i = 0; i < n; i++) {
		rows[i] = decodeRow(rowBuf, i * ROW_SIZE);
	}

	const readSizeMax = MAX_DATA_LEN * n;
	const dataOffset = ROW_SIZE * (n + 1);

	const dataBuf = Buffer.allocUnsafe(Math.min(readSizeMax, size - dataOffset));
	if ((await wal.read(dataBuf)).bytesRead < dataBuf.length) throw new Error(`db.wal: truncated, no enough data for ${n} rows.`);

	let dataPos = 0;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (dataPos + row.len > dataBuf.length) throw new Error(`db.wal: truncated, missed data #${i}`);
		row.data = dataBuf.subarray(dataPos, dataPos + row.len);
		dataPos += row.len;
	}
	return rows;
}

/**
 * 校验非负整数范围。非整数抛 TypeError，越界抛 RangeError。
 * @param {number} v
 * @param {string} name
 * @param {number} max
 * @returns {number}
 */
function assertUInt(v, name, max) {
	if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer, got ${v}`);
	if (v < 0 || v > max) throw new RangeError(`${name} must be an integer in [0, ${max}], got ${v}`);
	return v;
}

const IGNORE = () => {};

class PageCache {
	/** @type {import('node:fs/promises').FileHandle} */
	#file;
	/** @type {Map<number, Buffer>} */
	#pages;

	constructor(file, cap) {
		this.#file = file;
		this.#pages = new LRUCache(cap);
	}

	/**
	 *
	 * @param {number} off
	 * @param {number} len
	 * @return {Promise<Buffer>}
	 */
	async read(off, len) {
		let out;
		let r = 0;
		while (r < len) {
			const pos = off + r;
			let page = this.#pages.get(pos >> 12);
			if (!page) {
				page = Buffer.allocUnsafe(4096);
				const len = (await this.#file.read(page, 0, 4096, pos & (~4095))).bytesRead;
				page = page.subarray(0, len);
				this.#pages.set(pos >> 12, page);
			}

			const inPage = pos & 4095;
			const read = Math.min(len - r, 4096 - inPage);
			if (read === 0) break;
			if (read === len) return page.subarray(inPage, inPage + read);
			else if (!out) out = Buffer.allocUnsafe(len);

			page.copy(out, r, inPage, inPage + read);
			r += read;
		}

		if (len === 0) return Buffer.allocUnsafe(0);
		return r < len ? out.subarray(0, r) : out;
	}

	/**
	 *
	 * @param {number} off
	 * @param {number} len
	 */
	invalidate(off, len) {
		let r = 0;
		while (r < len) {
			const pos = off + r;
			this.#pages.delete(pos >> 12);
			r += 4096;
		}
	}
}

export class TSDB {
	#basePath;
	/** @type {import('node:fs/promises').FileHandle} */
	#index;
	/** @type {import('node:fs/promises').FileHandle} */
	#data;
	#write = Promise.resolve();
	#pending = [];
	/** @type {number} */
	#dataLen;
	/** @type {number} */
	#rowCount;
	/** @type {number} */
	#lastTime;
	/** @type {Map<number, LogItem>} */
	#lookup = new LRUCache(1000);

	/** @type {PageCache} */
	#indexCache;
	/** @type {PageCache} */
	#dataCache;

	/**
	 * 打开文件读写句柄；若文件不存在则先创建空文件，再以 `r+` 打开。
	 * `r+` 会尊重显式写入位置并允许 truncate，这是回拨/崩溃恢复所必须的。
	 * @param {string} filePath
	 * @returns {Promise<import('node:fs/promises').FileHandle>}
	 */
	async #openOrCreate(filePath) {
		try {
			return await fs.open(filePath, 'r+');
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
			const fh = await fs.open(filePath, 'a');
			await fh.close();
			return await fs.open(filePath, 'r+');
		}
	}

	/**
	 *
	 * @param {string} filePath
	 */
	async #init(filePath) {
		this.#basePath = filePath;
		this.#index = await this.#openOrCreate(filePath + '.idx');
		this.#data = await this.#openOrCreate(filePath + '.dat');

		const dat = await this.#data.stat();
		const idx = await this.#index.stat();
		if (idx.size === 0) {
			const header = Buffer.alloc(HEADER_SIZE);
			header.write(MAGIC_LOGD, 0, 'ascii');
			await this.#index.write(header, 0, HEADER_SIZE, 0);
			this.#rowCount = 0;
		} else {
			if (idx.size < HEADER_SIZE) throw new Error(`db.idx: size ${idx.size} < header ${HEADER_SIZE}`);

			const magic = Buffer.allocUnsafe(4);
			const { bytesRead } = await this.#index.read(magic, 0, 4, 0);
			if (bytesRead !== 4 || magic.toString('ascii') !== MAGIC_LOGD) {
				throw new Error('db.idx: magic mismatch');
			}
			this.#rowCount = Math.floor((idx.size - HEADER_SIZE) / ROW_SIZE);
		}

		this.#indexCache = new PageCache(this.#index, 128);
		this.#dataCache = new PageCache(this.#data, 128);

		// 记录最后一行信息，供追加定位
		if (this.#rowCount > 0) {
			const m = await this.#get(this.#rowCount - 1);
			const dataLen = m.off + m.len;
			if (dat.size < dataLen) throw new Error(`db.dat: size ${dat.size} < last row end ${dataLen}`);
			this.#dataLen = dataLen;
			this.#lastTime = m.time;
		} else {
			this.#dataLen = 0;
			this.#lastTime = -1;
		}

		const tmpPath = this.#basePath + '.wal';

		let wal;
		try {
			wal = await fs.open(tmpPath, 'r');
		} catch {}
		if (wal) {
			const rows = await readWAL(wal);
			await wal.close();

			const present = new Set();
			for (let i = 0; i < this.#rowCount; i++) {
				const m = await this.#get(i);
				present.add(`${m.owner}:${m.time}`);
			}

			for (const row of rows) {
				if (present.has(`${row.owner}:${row.time}`)) continue;
				this.#pending.push(row);
			}

			if (!this.#pending.length) {
				await fs.rm(tmpPath, { force: true });
			}
		}
	}

	async close() {
		await this.#data.close();
		await this.#index.close();
	}

	static async create(filePath, options) {
		const db = new TSDB(options);
		await db.#init(filePath);
		return db;
	}

	get size() {
		return this.#rowCount;
	}

	/**
	 * @param {number} lo
	 * @param {number} hi
	 * @param {number} time
	 * @param {number} cmp
	 * @returns {Promise<number>}
	 */
	async #find(lo, hi, time, cmp) {
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const t = (await this.#get(mid)).time - time;
			if (t < cmp) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}


	/**
	 * @template T
	 * @param {function(?): T | Promise<T>} task
	 * @return {T | Promise<T>}
	 */
	#enqueue(task) {
		const promise = this.#write.then(task);
		this.#write = promise.catch(IGNORE);
		return promise;
	}

	/**
	 * @param {Uint8Array} data 原始负载，长度 <= 255；超长抛 RangeError 且不落盘
	 * @param {number} owner u32 业务主键；`0` 视为 NULL。唯一性由调用方保证
	 * @param {number} [time=Date.now()] UNIX 毫秒时间戳（u48），缺省取当前时间
	 * @returns {Promise<number>} 新行 id（= 追加前 rowCount）
	 */
	append(data, owner, time = Date.now()) {
		const own = owner ?? 0;
		if (!Number.isInteger(own) || own < 0 || own > 0xffffffff) {
			throw new TypeError(`Owner must be a positive integer <= 0xffffffff, got ${owner}`);
		}
		assertUInt(time, 'time', MAX_U48);
		if (data.length > MAX_DATA_LEN) throw new RangeError(`data length ${data.length} exceeds ${MAX_DATA_LEN}`);
		return this.#enqueue(() => this.#append(data, own, time));
	}

	async #append(buf, owner, time) {
		if (this.#pending.length) {
			while (this.#pending[0].time <= time) {
				const r = this.#pending.shift();
				await this.#doAppend(r.data, r.owner, r.time);
				this.#lookup.delete(r.owner);

				if (!this.#pending.length) {
					await fs.rm(this.#basePath+'.wal', { force: true });
					break;
				}
			}
		}

		if (this.#rowCount && time < this.#lastTime) await this.#timeSync(time);

		return this.#doAppend(buf, owner, time);
	}

	/**
	 * @param {number} before
	 * @returns {Promise<void>}
	 */
	async #timeSync(before) {
		const last = this.#rowCount - 1;
		const first = await this.#find(0, this.#rowCount, before, 1);
		if (first > last) return;

		const rowCount = last - first + 1;
		if (rowCount > 65536) throw new Error('time sync record too large');

		// 顺序:
		// 1. 写 tmp 以便崩溃恢复
		// 2. 截断 size 让读取不超过文件范围
		// 3. 真实截断文件
		this.#pending = await this.#createWAL(first, last);
		this.#rowCount = first;

		const prevDataLen = this.#dataLen;

		if (first > 0) {
			const firstRow = await this.#get(first - 1);
			this.#dataLen = firstRow.off + firstRow.len;
			this.#lastTime = firstRow.time;
		} else {
			this.#dataLen = 0;
			this.#lastTime = -1;
		}

		// 失效 id >= first 的缓存项
		// this.#lookup.prune((key, value) => value && value.id >= first);

		const len = HEADER_SIZE + first * ROW_SIZE;

		this.#dataCache.invalidate(this.#dataLen, prevDataLen);
		this.#indexCache.invalidate(len, HEADER_SIZE + last * ROW_SIZE);

		await this.#index.truncate(len);
		await this.#data.truncate(this.#dataLen);
	}

	/**
	 * @param {number} first
	 * @param {number} last
	 * @return {LogItem[]}
	 */
	async #createWAL(first, last) {
		const rows = last - first + 1;

		const metaBuf = Buffer.allocUnsafe(rows * ROW_SIZE);
		await this.#index.read(metaBuf, 0, metaBuf.length, HEADER_SIZE + first * ROW_SIZE);

		const out = await fs.open(this.#basePath + '.wal', 'w');

		const header = Buffer.allocUnsafe(ROW_SIZE);
		header.write(MAGIC_LOGT, 0, 'ascii');
		header.writeUInt32BE(rows, 4);

		await out.write(header);
		await out.write(metaBuf);

		const pending = [];
		for (let i = 0; i < rows; i++) pending.push(decodeRow(metaBuf, i * ROW_SIZE));

		const dataBegin = pending[0].off;
		const dataEnd = pending.at(-1).off + pending.at(-1).len;

		const dataBuf = Buffer.allocUnsafe(dataEnd - dataBegin);
		await this.#data.read(dataBuf, 0, dataBuf.length, dataBegin);

		await out.write(dataBuf);

		for (let i = 0; i < rows; i++) {
			const row = pending[i];
			row.data = dataBuf.subarray(row.off - dataBegin, row.off + row.len - dataBegin);
		}

		await out.close();

		return pending.concat(this.#pending);
	}

	/**
	 *
	 * @param {Uint8Array} data
	 * @param {number} owner
	 * @param {number} time
	 * @returns {Promise<number>}
	 */
	async #doAppend(data, owner, time) {
		const diskTime = time - TIME_BASE;
		if (diskTime < 0) throw new Error("Time too early");

		const off = this.#dataLen;
		const len = data.length;
		await this.#data.write(data, 0, len, off);
		this.#dataCache.invalidate(off, len);

		const row = Buffer.allocUnsafe(ROW_SIZE);

		// time: u48 = high16 << 32 | low32
		row.writeUInt16BE(Math.floor(diskTime / 0x100000000), 0);
		row.writeUInt32BE(diskTime >>> 0, 2);
		// owner: u32
		row.writeUInt32BE(owner >>> 0, 6);
		// off: u40 = high8 << 32 | low32
		row.writeUInt8(Math.floor(off / 0x100000000), 10);
		row.writeUInt32BE(off >>> 0, 11);
		// len: u8
		row.writeUInt8(len, 15);

		const position = HEADER_SIZE + this.#rowCount * ROW_SIZE;
		await this.#index.write(row, 0, ROW_SIZE, position);
		this.#indexCache.invalidate(position, ROW_SIZE);

		this.#dataLen += len;
		this.#lastTime = time;
		return this.#rowCount++;
	}

	/**
	 * 批量更新
	 * @param {Map<number, Uint8Array>} updates
	 * @returns {Promise<void>}
	 */
	async update(updates) {
		const ids = [...updates.keys()].sort((a, b) => a - b);
		if (!ids.every(s => Number.isSafeInteger(s) && s >= 0)) throw new RangeError("Some indices are invalid.");

		return this.#enqueue(async () => {
			const count = this.#rowCount;
			const lastId = ids.at(-1);
			if (lastId >= count) throw new RangeError(`id ${lastId} out of range (rowCount=${count})`);

			let first = ids[0];
			let firstMeta;
			for (; first < count; first++) {
				if (!updates.has(first)) continue;
				firstMeta = await this.#get(first);
				const u = updates.get(first);
				if (u == null || Buffer.compare(u, await this.#getData(firstMeta.off, firstMeta.len)) !== 0) break;
			}

			let layoutChanged = false;
			let dataSize = 0;
			const rows = [];

			for (let i = first; i < count; i++) {
				const u = updates.get(i);
				// null = 删除
				if (u === null) {
					layoutChanged = true;
					continue;
				}

				const offset = HEADER_SIZE + i * ROW_SIZE;
				const buf = await this.#indexCache.read(offset, ROW_SIZE);
				if (buf.length !== ROW_SIZE) throw new Error(`corrupt: db.idx row #${i} truncated`);

				const row = decodeRow(buf);
				let data = await this.#getData(row.off, row.len);

				// 变更。
				if (u !== undefined && Buffer.compare(u, data) !== 0) {
					row.changed = true;

					if (data.length !== u.length) {
						if (u.length > MAX_DATA_LEN) throw new RangeError("data for row "+i+" too long");
						layoutChanged = true;
					}

					data = u;
				}

				row.buf = buf;
				row.data = data;
				row.len = data.length;

				dataSize += data.length;
				rows.push(row);
			}

			if (!layoutChanged) {
				for (const row of rows) {
					if (!row.changed) continue;

					const data = row.data;
					await this.#data.write(data, 0, data.length, row.off);
					this.#dataCache.invalidate(row.off, row.len);

					if (row.owner !== NULL_OWNER) this.#lookup.delete(row.owner);
				}
				return;
			}

			this.#rowCount = first;

			let dataOffset = firstMeta.off;

			const dataStream = createWriteStream(this.#basePath+".dat", {
				flags: 'r+',
				start: dataOffset
			});
			const indexStream =  createWriteStream(this.#basePath+".idx", {
				flags: 'r+',
				start: HEADER_SIZE + first * ROW_SIZE
			});

			const writeData = async () => {
				for (const row of rows) {
					let data = row.data;
					if (row.changed && row.owner !== NULL_OWNER) this.#lookup.delete(row.owner);
					if (!dataStream.write(data)) await new Promise(r => dataStream.once('drain', r));
				}

				await new Promise(r => dataStream.close(r));
				await this.#index.truncate(HEADER_SIZE + (first + rows.length) * ROW_SIZE);
			};
			const writeIndex = async () => {
				for (const row of rows) {
					let buf = row.buf;
					let len = row.len;

					buf.writeUInt8(Math.floor(dataOffset / 0x100000000), 10);
					buf.writeUInt32BE(dataOffset >>> 0, 11);
					buf.writeUInt8(len, 15);

					dataOffset += len;

					if (!indexStream.write(buf)) await new Promise(r => indexStream.once('drain', r));
				}

				await new Promise(r => indexStream.close(r));
				await this.#data.truncate(dataOffset);
			};

			await Promise.all([writeData(), writeIndex()]);

			this.#dataCache.invalidate(firstMeta.off, this.#dataLen - firstMeta.off);
			this.#dataLen = dataOffset;

			this.#indexCache.invalidate(HEADER_SIZE + first * ROW_SIZE, (count - first) * ROW_SIZE);
			this.#rowCount = first + rows.length;
		});
	}

	/**
	 *
	 * @param {number} id
	 * @return {Promise<{time: number, owner: number, off: number, len: number}>}
	 */
	async #get(id) {
		const offset = HEADER_SIZE + id * ROW_SIZE;
		const buf = await this.#indexCache.read(offset, ROW_SIZE);
		if (buf.length !== ROW_SIZE) throw new Error(`corrupt: db.idx row #${id} truncated`);
		return decodeRow(buf);
	}

	/**
	 * @param {number} off
	 * @param {number} len
	 * @returns {Promise<Buffer>}
	 */
	async #getData(off, len) {
		const buf = await this.#dataCache.read(off, len);
		if (buf.length !== len) throw new Error(`corrupt: db.dat [${off}, ${off + len}) truncated`);
		return buf;
	}

	/**
	 * @param {number} id
	 * @returns {Promise<LogItem | undefined>}
	 */
	async get(id) {
		if (id < 0 || id >= this.#rowCount) return;
		const row = await this.#get(id);
		const data = await this.#getData(row.off, row.len);
		return { id, time: row.time, owner: row.owner, data };
	}

	/**
	 * @param {number} owner
	 * @returns {Promise<LogItem | undefined>}
	 */
	async getByOwnerId(owner) {
		if (owner === NULL_OWNER) return;

		const cached = this.#lookup.get(owner);
		if (cached) return cached;

		const count = this.#rowCount;
		if (count === 0) return;

		/** @type {number} */
		let lo = 0, hi = count, mid;
		/** @type {Object} */
		let row;
		let o;
		let found = false;

		while (lo < hi) {
			mid = (lo + hi) >>> 1;
			row = await this.#get(mid);
			o = row.owner;
			if (o === NULL_OWNER) {
				o = await this.#findOwner(mid);
				if (o === NULL_OWNER) return;
			}

			if (o === owner) { found = true; break; }
			if (o < owner) lo = mid + 1;
			else hi = mid;
		}
		if (!found) return;

		row.id = mid;
		row.data = await this.#getData(row.off, row.len);
		delete row.off;
		delete row.len;

		this.#lookup.set(row.owner, row);

		// 额外读取至多50条
		const end = Math.min(count, mid + 50);
		for (let i = mid + 1; i < end; i++) {
			const r = await this.#get(i);
			if (r.owner === NULL_OWNER) break;

			r.id = i;
			r.data = await this.#getData(r.off, r.len);

			delete r.off;
			delete r.len;

			this.#lookup.set(r.owner, r);
		}

		return row;
	}

	/**
	 * @param {number} center
	 * @returns {Promise<number>}
	 */
	async #findOwner(center) {
		for (let d = 1; ; d++) {
			let hasNext = 0;
			const i = center + d;
			if (i < this.#rowCount) {
				const row = await this.#get(i);
				if (row.owner !== NULL_OWNER) return row.owner;
				hasNext = 1;
			}
			const j = center - d;
			if (j >= 0) {
				const row = await this.#get(j);
				if (row.owner !== NULL_OWNER) return row.owner;
				hasNext = 1;
			}

			if (!hasNext) return NULL_OWNER;
		}
	}

	/**
	 * @param {number} startTime
	 * @param {number} endTime
	 * @param {FindByTimeOptions} [options]
	 * @returns {Promise<LogRange | null>} 无匹配返回 `null`
	 */
	async findByTime(startTime, endTime, options = {}) {
		assertUInt(startTime, 'startTime', MAX_U48);
		assertUInt(endTime, 'endTime', MAX_U48);
		if (startTime > endTime) throw new RangeError('startTime must be <= endTime');
		const { startOwnerId, endOwnerId } = options;
		if (startOwnerId !== undefined && startOwnerId !== null) assertUInt(startOwnerId, 'startOwnerId', 0xffffffff);
		if (endOwnerId !== undefined && endOwnerId !== null) assertUInt(endOwnerId, 'endOwnerId', 0xffffffff);

		const count = this.#rowCount;
		let lo = await this.#find(0, count, startTime, 0);
		let hi = await this.#find(lo, count, endTime, 1);
		if (lo >= hi) return null;

		// owner 约束
		if (startOwnerId) {
			while (lo < hi) {
				const m = await this.get(lo);
				if (m.owner !== NULL_OWNER && m.owner >= startOwnerId) break;
				lo++;
			}
		}
		if (endOwnerId) {
			while (hi > lo) {
				const m = await this.get(hi - 1);
				if (m.owner !== NULL_OWNER && m.owner <= endOwnerId) break;
				hi--;
			}
		}
		if (lo >= hi) return null;

		const first = await this.#get(lo);
		const last = await this.#get(hi - 1);

		const result = {
			firstId: lo,
			lastId: hi - 1,
			offset: first.off,
			length: last.off + last.len - first.off,
		};

		if (first.owner !== NULL_OWNER) result.startOwnerId = first.owner;
		if (last.owner !== NULL_OWNER) result.endOwnerId = last.owner;

		return result;
	}

	/**
	 *
	 * @param {number} offset
	 * @param {number} length
	 * @returns {import('node:fs').ReadStream}
	 */
	createReadStream(offset, length) {
		if (length == null) return this.#data.createReadStream({ start: offset, autoClose: false });
		if (length < 0) throw new RangeError('length must be >= 0');
		if (length === 0) return Readable.from([]);
		return this.#data.createReadStream({ start: offset, end: offset + length - 1, autoClose: false });
	}
}
