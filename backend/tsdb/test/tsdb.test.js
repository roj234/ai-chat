import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {decodeRow, MAGIC_LOGT, MAX_DATA_LEN, ROW_SIZE, TSDB,} from '../src/tsdb.js';

/**
 * 在系统临时目录下创建一次性数据库根路径（不含扩展名）。
 * @returns {Promise<{dir: string, dbPath: string}>}
 */
async function tmpDbPath() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsdb-'));
	return { dir, dbPath: path.join(dir, 'db') };
}

async function cleanup(dir) {
	await fs.rm(dir, {recursive: true, force: true});
}

/**
 * 与 src.tsdb 的 decodeRow 互逆：把行元数据编码为 ROW_SIZE 字节写入 buf 的 offset 处。
 * @param {Buffer} buf
 * @param {{time: number, owner: number, off: number, len: number}} meta
 * @param {number} offset
 */
function encodeRowMeta(buf, meta, offset) {
	buf.writeUInt16BE(Math.floor(meta.time / 0x100000000), offset);
	buf.writeUInt32BE(meta.time >>> 0, offset + 2);
	buf.writeUInt32BE(meta.owner >>> 0, offset + 6);
	buf.writeUInt8(Math.floor(meta.off / 0x100000000), offset + 10);
	buf.writeUInt32BE(meta.off >>> 0, offset + 11);
	buf.writeUInt8(meta.len, offset + 15);
}

/**
 * 手动写一个 db.wal（HEADER(ROW_SIZE) + META[count] + DATA），格式与 src 的 .wal 一致。
 * @param {string} dbPath
 * @param {Array<{time: number, owner: number, off: number, data: Uint8Array}>} rows
 */
async function writeWalFile(dbPath, rows) {
	const metaTotal = rows.length * ROW_SIZE;
	let dataTotal = 0;
	for (const r of rows) dataTotal += r.data.length;
	const buf = Buffer.allocUnsafe(ROW_SIZE + metaTotal + dataTotal);
	buf.write(MAGIC_LOGT, 0, 'ascii');
	buf.writeUInt32BE(rows.length, 4);
	let pos = ROW_SIZE;
	// META 块
	for (const r of rows) {
		encodeRowMeta(buf, { time: r.time, owner: r.owner, off: r.off, len: r.data.length }, pos);
		pos += ROW_SIZE;
	}
	// DATA 块
	for (const r of rows) {
		Buffer.from(r.data).copy(buf, pos);
		pos += r.data.length;
	}
	await fs.writeFile(dbPath + '.wal', buf);
}

/**
 * 读取 src 生成的 db.wal，返回 {rows: [{time, owner, off, len, data}]}。
 * @param {string} walPath
 */
async function readWal(walPath) {
	const buf = await fs.readFile(walPath);
	if (buf.length < ROW_SIZE) throw new Error('db.wal: too small');
	if (buf.toString('ascii', 0, 4) !== MAGIC_LOGT) throw new Error('db.wal: magic mismatch');

	const n = buf.readUInt32BE(4);
	const dataOffset = ROW_SIZE * (n + 1);
	const rows = [];
	let dataPos = dataOffset;
	for (let i = 0; i < n; i++) {
		const row = decodeRow(buf, ROW_SIZE + i * ROW_SIZE);
		if (dataPos + row.len > buf.length) throw new Error(`db.wal: truncated, missed data #${i}`);
		row.data = buf.subarray(dataPos, dataPos + row.len);
		dataPos += row.len;
		rows.push(row);
	}
	return { rows };
}

test('append / get / size basic roundtrip', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	assert.equal(db.size, 0);
	const id0 = await db.append(Uint8Array.from([1, 2, 3]), 10, 1000);
	assert.equal(id0, 0);
	const id1 = await db.append(Uint8Array.from([4, 5]), 20, 2000);
	assert.equal(id1, 1);
	assert.equal(db.size, 2);

	const r0 = await db.get(0);
	assert.equal(r0.id, 0);
	assert.equal(r0.time, 1000);
	assert.equal(r0.owner, 10);
	assert.deepEqual([...r0.data], [1, 2, 3]);

	const r1 = await db.get(1);
	assert.equal(r1.id, 1);
	assert.equal(r1.time, 2000);
	assert.equal(r1.owner, 20);
	assert.deepEqual([...r1.data], [4, 5]);

	await assert.equal(await db.get(2), undefined);
});

test('getByOwnerId returns the row with matching owner', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	// getByOwnerId 依赖 owner 与行号同序（owner 二分定位，无索引）
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 7, 100);
	await db.append(Uint8Array.from([2]), 42, 200);
	await db.append(Uint8Array.from([3]), 99, 300);

	const row = await db.getByOwnerId(42);
	assert.equal(row.id, 1);
	assert.deepEqual([...row.data], [2]);

	const row7 = await db.getByOwnerId(7);
	assert.equal(row7.id, 0);
	assert.deepEqual([...row7.data], [1]);

	const row99 = await db.getByOwnerId(99);
	assert.equal(row99.id, 2);
	assert.deepEqual([...row99.data], [3]);

	assert.equal(await db.getByOwnerId(0), undefined);
	assert.equal(await db.getByOwnerId(12345), undefined);
});

test('findByTime basic contiguous range', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	// 每个 data 长度都为 3，偏移即 3*i
	for (const [time, owner] of [[100, 1], [200, 2], [300, 3], [400, 4], [500, 5]]) {
		await db.append(Uint8Array.from([time & 0xff, 0, 0]), owner, time);
	}

	const r = await db.findByTime(150, 450);
	assert.equal(r.firstId, 1);
	assert.equal(r.lastId, 3);
	assert.equal(r.offset, 3);       // row1.off
	assert.equal(r.length, 9);       // row3.off(9)+3 - row1.off(3)
	assert.equal(r.startOwnerId, 2);
	assert.equal(r.endOwnerId, 4);

	// 无匹配返回 null
	assert.equal(await db.findByTime(600, 700), null);
	assert.equal(await db.findByTime(50, 60), null);
});

test('findByTime owner constraint', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 5, 100);
	await db.append(Uint8Array.from([2]), 6, 200);
	await db.append(Uint8Array.from([3]), 7, 300);

	const r = await db.findByTime(100, 300, { startOwnerId: 6, endOwnerId: 7 });
	assert.equal(r.firstId, 1);
	assert.equal(r.lastId, 2);
	assert.equal(r.startOwnerId, 6);
	assert.equal(r.endOwnerId, 7);
});

test('validation errors', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	// append 的参数校验是同步抛出的
	assert.throws(() => db.append(new Uint8Array(MAX_DATA_LEN + 1), 1, 100), RangeError);
	//assert.equal(() => db.append(new Uint8Array([1]), 0, 100), 1);
	assert.throws(() => db.append(new Uint8Array([1]), NaN, 100), TypeError);
	assert.throws(() => db.append(new Uint8Array([1]), 1.5, 100), TypeError);
	assert.throws(() => db.append(new Uint8Array([1]), 1, 1.5), TypeError);
	assert.throws(() => db.append(new Uint8Array([1]), 1, -1), RangeError);
	assert.throws(() => db.append(new Uint8Array([1]), 1, 0x10000000000000), RangeError);

	// findByTime 的参数校验在 async 体内，以 reject 形式抛出
	await assert.rejects(() => db.findByTime(200, 100), RangeError);
	await assert.rejects(() => db.findByTime(1.5, 200), TypeError);
});

test('time rollback: later rows removed and replayed in time order', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);

	// 追加 earlier time => 触发 rollback，移除 time>250 的行（即 c）
	const idD = await db.append(Uint8Array.from([4, 4, 4]), 4, 250);
	assert.equal(idD, 2); // c 被移除，d 占据 id2
	assert.equal(db.size, 3);

	// wal 应当可被 readWal 读取，且仅包含被移除的 c 的数据
	const wal = await readWal(dbPath + '.wal');
	assert.equal(wal.rows.length, 1);
	assert.equal(wal.rows[0].time, 300);
	assert.equal(wal.rows[0].owner, 3);
	assert.deepEqual([...wal.rows[0].data], [3, 3, 3]);

	// 追加 later time 300 => 重放 c，再追加 e
	const idE = await db.append(Uint8Array.from([5, 5, 5]), 5, 300);
	assert.equal(idE, 4); // [a,b,d,c,e]
	assert.equal(db.size, 5);

	const c = await db.get(3);
	assert.equal(c.time, 300);
	assert.equal(c.owner, 3);
	assert.deepEqual([...c.data], [3, 3, 3]);

	const e = await db.get(4);
	assert.equal(e.time, 300);
	assert.equal(e.owner, 5);
	assert.deepEqual([...e.data], [5, 5, 5]);

	// 回拨后数据依然连续且有序：a,b,d,c,e
	const r = await db.findByTime(100, 300, 10);
	assert.equal(r.firstId, 0);
	assert.equal(r.lastId, 4);
	assert.equal(r.offset, 0);
	assert.equal(r.length, 15);

	// wal 已随重放清空删除
	await assert.rejects(() => fs.access(dbPath + '.wal'), {code: 'ENOENT'});
});

test('crash recovery: reopen after rollback re-appends pending rows', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	let db = await TSDB.create(dbPath);
	t.after(async () => { if (db) await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);
	// 触发 rollback，移除 c(300)，append d(250)；此时 wal 记录 c，idx=[a,b,d]
	await db.append(Uint8Array.from([4, 4, 4]), 4, 250);
	await db.close(); // 模拟“回拨后、重放前”崩溃

	db = await TSDB.create(dbPath);
	assert.equal(db.size, 3); // a,b,d

	// 追加一个仍然小于 pending c.time(300) 的记录，不应丢失 c（merge 待回放）
	const idF = await db.append(Uint8Array.from([6, 6, 6]), 6, 260);
	assert.equal(idF, 3); // [a,b,d,f]
	assert.equal(db.size, 4);

	// 追加 >=300 的记录，触发重放 c，再追加 g
	const idG = await db.append(Uint8Array.from([7, 7, 7]), 7, 300);
	assert.equal(idG, 5); // [a,b,d,f,c,g]
	assert.equal(db.size, 6);

	const c = await db.get(4);
	assert.equal(c.time, 300);
	assert.equal(c.owner, 3);
	assert.deepEqual([...c.data], [3, 3, 3]);

	const g = await db.get(5);
	assert.equal(g.time, 300);
	assert.equal(g.owner, 7);
	assert.deepEqual([...g.data], [7, 7, 7]);
});

test('crash recovery: stale wal whose rows already in idx is discarded', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	let db = await TSDB.create(dbPath);
	t.after(async () => { if (db) await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 1, 100);
	await db.append(Uint8Array.from([2]), 2, 200);
	await db.append(Uint8Array.from([3]), 3, 300);

	const c = await db.get(2);
	// 伪造一个 wal，内容正是已存在 idx 中的 c 行（owner+time 重复）
	await writeWalFile(dbPath, [{ time: c.time, owner: c.owner, off: c.off, data: c.data }]);
	await db.close();

	db = await TSDB.create(dbPath);
	assert.equal(db.size, 3);
	// 因为 wal 的行已存在于 idx，pending 应为空，wal 被删除
	await assert.rejects(() => fs.access(dbPath + '.wal'), {code: 'ENOENT'});

	// 追加 should not 重复 c
	const idD = await db.append(Uint8Array.from([4]), 4, 400);
	assert.equal(idD, 3);
	assert.equal(db.size, 4);

	const d = await db.get(3);
	assert.equal(d.owner, 4);
	assert.deepEqual([...d.data], [4]);
});

test('readWal validates structure and content', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	t.after(() => cleanup(dir));

	await writeWalFile(dbPath, [
		{ time: 100, owner: 7, off: 0, data: Uint8Array.from([0xde, 0xad]) },
		{ time: 200, owner: 9, off: 2, data: Uint8Array.from([0xbe, 0xef]) },
	]);
	const { rows } = await readWal(dbPath + '.wal');
	assert.equal(rows.length, 2);
	assert.deepEqual([...rows[0].data], [0xde, 0xad]);
	assert.equal(rows[0].owner, 7);
	assert.equal(rows[0].time, 100);
	assert.deepEqual([...rows[1].data], [0xbe, 0xef]);

	// 太小
	const tiny = Buffer.from([1, 2, 3]);
	await fs.writeFile(dbPath + '.wal', tiny);
	await assert.rejects(() => readWal(dbPath + '.wal'), /too small/);

	// magic 不匹配
	const bad = Buffer.alloc(ROW_SIZE);
	await fs.writeFile(dbPath + '.wal', bad);
	await assert.rejects(() => readWal(dbPath + '.wal'), /magic mismatch/);
});
test('multiple rollbacks merge pending rows and keep data contiguous', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 1, 100);
	await db.append(Uint8Array.from([2]), 2, 200);
	await db.append(Uint8Array.from([3]), 3, 300);

	// 第一次回拨：移除 c(300)，pending=[c]
	await db.append(Uint8Array.from([4]), 4, 250);
	assert.equal(db.size, 3);

	// 第二次回拨（更早）：移除 b(200)、d(250)，且不应丢失此前 pending 的 c
	const idE = await db.append(Uint8Array.from([5]), 5, 150);
	assert.equal(idE, 1); // [a, e]
	assert.equal(db.size, 2);

	// 时间追平后重放 b, d, c，最后再追加 f
	const idF = await db.append(Uint8Array.from([6]), 6, 400);
	assert.equal(idF, 5); // [a, e, b, d, c, f]
	assert.equal(db.size, 6);

	const rows = [];
	for (let i = 0; i < db.size; i++) {
		const r = await db.get(i);
		rows.push({ time: r.time, owner: r.owner, data: [...r.data] });
	}
	assert.deepEqual(rows, [
		{ time: 100, owner: 1, data: [1] },
		{ time: 150, owner: 5, data: [5] },
		{ time: 200, owner: 2, data: [2] },
		{ time: 250, owner: 4, data: [4] },
		{ time: 300, owner: 3, data: [3] },
		{ time: 400, owner: 6, data: [6] },
	]);

	// 多次回拨后数据仍连续、有序
	const r = await db.findByTime(100, 400);
	assert.equal(r.offset, 0);
	assert.equal(r.length, 6);
	assert.equal(r.firstId, 0);
	assert.equal(r.lastId, 5);
});

test('crash recovery: partial re-append does not double-append', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	let db = await TSDB.create(dbPath);
	t.after(async () => { if (db) await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 1, 100);
	await db.append(Uint8Array.from([2]), 2, 200);
	await db.append(Uint8Array.from([3]), 3, 300);
	await db.append(Uint8Array.from([4]), 4, 400);

	// rollback 到 250：移除 c(300)、d(400)，pending=[c,d]
	await db.append(Uint8Array.from([5]), 5, 250);
	assert.equal(db.size, 3); // a,b,e

	// 只重放 c(300)，剩余 d(400) 仍在 pending；wal 尚未删除
	await db.append(Uint8Array.from([6]), 6, 350);
	assert.equal(db.size, 5); // a,b,e,c,f
	// wal 仍存在（含 c,d）
	await fs.access(dbPath + '.wal');

	await db.close(); // 模拟“部分重放后”崩溃

	db = await TSDB.create(dbPath);
	assert.equal(db.size, 5); // a,b,e,c,f

	// 追加 400，应只重放 d，不重复 c
	const idG = await db.append(Uint8Array.from([7]), 7, 400);
	assert.equal(idG, 6); // a,b,e,c,f,d,g
	assert.equal(db.size, 7);

	const rows = [];
	for (let i = 0; i < db.size; i++) {
		const r = await db.get(i);
		rows.push({ time: r.time, owner: r.owner, data: [...r.data] });
	}
	assert.deepEqual(rows, [
		{ time: 100, owner: 1, data: [1] },
		{ time: 200, owner: 2, data: [2] },
		{ time: 250, owner: 5, data: [5] },
		{ time: 300, owner: 3, data: [3] },
		{ time: 350, owner: 6, data: [6] },
		{ time: 400, owner: 4, data: [4] },
		{ time: 400, owner: 7, data: [7] },
	]);
});

test('update same-length data in place', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);

	await db.update(new Map([[1, Uint8Array.from([9, 9, 9])]]));

	const r1 = await db.get(1);
	assert.equal(r1.id, 1);
	assert.equal(r1.time, 200);   // time 不变
	assert.equal(r1.owner, 2);    // owner 不变
	assert.deepEqual([...r1.data], [9, 9, 9]);

	// 其他行不受影响
	assert.deepEqual([...(await db.get(0)).data], [1, 1, 1]);
	assert.deepEqual([...(await db.get(2)).data], [3, 3, 3]);

	// 连续区间总长不变
	const range = await db.findByTime(100, 300);
	assert.equal(range.length, 9);
});

test('update identical data is a no-op', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([7, 7, 7]), 1, 100);
	await db.update(new Map([[0, Uint8Array.from([7, 7, 7])]]));

	const r = await db.get(0);
	assert.deepEqual([...r.data], [7, 7, 7]);
	assert.equal(db.size, 1);
});

test('update length change rewrites tail suffix', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);

	// 变长：row1 3 -> 2 字节，row2 前移
	await db.update(new Map([[1, Uint8Array.from([4, 4])]]));

	assert.deepEqual([...(await db.get(1)).data], [4, 4]);
	assert.deepEqual([...(await db.get(2)).data], [3, 3, 3]);
	// 数据连续：row0[0,3) row1[3,5) row2[5,8)
	const range = await db.findByTime(100, 300);
	assert.equal(range.offset, 0);
	assert.equal(range.length, 8);

	const stream = db.createReadStream(0, 8);
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	assert.deepEqual([...Buffer.concat(chunks)], [1, 1, 1, 4, 4, 3, 3, 3]);
});

test('update tail grow appends to data file', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);

	await db.update(new Map([[1, Uint8Array.from([9, 9, 9, 9, 9])]]));

	assert.deepEqual([...(await db.get(1)).data], [9, 9, 9, 9, 9]);
	const range = await db.findByTime(100, 200);
	assert.equal(range.length, 8); // 3 + 5
});

test('transaction batches multiple updates', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);

	const tx = new Map([
		[0, Uint8Array.from([8, 8, 8, 8])],
		[1, Uint8Array.from([7, 7])],
		[2, Uint8Array.from([6, 6])]
	]);
	await db.update(tx);

	assert.deepEqual([...(await db.get(0)).data], [8, 8, 8, 8]);
	assert.deepEqual([...(await db.get(1)).data], [7, 7]);
	assert.deepEqual([...(await db.get(2)).data], [6, 6]);

	// 数据连续：row0[0,4) row1[4,6) row2[6,8)
	const range = await db.findByTime(100, 300);
	assert.equal(range.offset, 0);
	assert.equal(range.length, 8);

	const stream = db.createReadStream(0, 8);
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	assert.deepEqual([...Buffer.concat(chunks)], [8, 8, 8, 8, 7, 7, 6, 6]);
});

test('getByOwnerId reflects updated data (cache invalidation)', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 42, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 99, 200);

	// 先触发 owner=42 的缓存
	assert.deepEqual([...(await db.getByOwnerId(42)).data], [1, 1, 1]);

	await db.update(new Map([[0, Uint8Array.from([9, 9, 9])]]));
	assert.deepEqual([...(await db.getByOwnerId(42)).data], [9, 9, 9]);
});

test('update validation and out-of-range', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1]), 1, 100);

	// 超长同步抛
	assert.throws(() => db.update(new Map([[0, new Uint8Array(MAX_DATA_LEN + 1)]])), RangeError);
	// 非法 id 同步抛
	assert.throws(() => db.update(new Map([[-1, Uint8Array.from([1])]])), TypeError);
	assert.throws(() => db.update(new Map([[1.5, Uint8Array.from([1])]])), TypeError);
	// 越界异步 reject（提交时才校验 id 范围）
	await assert.rejects(() => db.update(new Map([[5, Uint8Array.from([1])]])), RangeError);
});

test('update after rollback then replay keeps data contiguous', async (t) => {
	const { dir, dbPath } = await tmpDbPath();
	const db = await TSDB.create(dbPath);
	t.after(async () => { await db.close(); await cleanup(dir); });

	await db.append(Uint8Array.from([1, 1, 1]), 1, 100);
	await db.append(Uint8Array.from([2, 2, 2]), 2, 200);
	await db.append(Uint8Array.from([3, 3, 3]), 3, 300);
	// 触发回拨：移除 row2(300)，追加 d(250)；pending=[c(300)]
	await db.append(Uint8Array.from([4, 4, 4]), 4, 250);
	assert.equal(db.size, 3);

	// 修改一个已提交行（变长）
	await db.update(new Map([[1, Uint8Array.from([9, 9])]]));
	assert.deepEqual([...(await db.get(1)).data], [9, 9]);
	assert.equal(db.size, 3);

	// 追加 >=300 触发重放 c，再追加 e
	await db.append(Uint8Array.from([5, 5, 5]), 5, 300);
	assert.equal(db.size, 5);

	const rows = [];
	for (let i = 0; i < db.size; i++) {
		const r = await db.get(i);
		rows.push({ time: r.time, owner: r.owner, data: [...r.data] });
	}
	assert.deepEqual(rows, [
		{ time: 100, owner: 1, data: [1, 1, 1] },
		{ time: 200, owner: 2, data: [9, 9] },
		{ time: 250, owner: 4, data: [4, 4, 4] },
		{ time: 300, owner: 3, data: [3, 3, 3] },
		{ time: 300, owner: 5, data: [5, 5, 5] },
	]);
});
