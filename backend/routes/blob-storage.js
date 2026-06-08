import {join} from 'node:path';
import {createReadStream, createWriteStream} from 'node:fs';
import {access, mkdir, rename, unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';

import {DatabaseSync} from 'node:sqlite';
import {cachePreparedSql} from "../utils/sqliteUtils.js";

// 50MB
const MAX_UPLOAD_SIZE = 52428800;
// 数据库版本号
const DB_VERSION = 1;

/**
 * @param {AiChatBackend.Router} router
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 * @param {string} blobDir
 */
export function registerBlobRoutes(router, batcher, blobDir) {
	const tempDir = join(blobDir, ".tmp");
	const dbPath = join(blobDir, 'index.db');
	/** @type {DatabaseSync} */
	let db;
	mkdir(tempDir, { recursive: true }).then(() => {
		db = new DatabaseSync(dbPath);
		const { user_version } = db.prepare('PRAGMA user_version').get();
		cachePreparedSql(db);

		if (user_version === 0) {
			db.exec(`
CREATE TABLE blobs (
    hash BLOB PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
	indexedName TEXT UNIQUE NULL,
    size INTEGER NOT NULL,
    lastModified INTEGER NOT NULL
) WITHOUT ROWID;
PRAGMA user_version = `+DB_VERSION);
		} else if (user_version === DB_VERSION) {
			return;
		} else {
			throw new Error("数据库版本号错误，请补充迁移函数");
		}
	});

	// 辅助函数：获取分桶路径 (例如: ab/cd/hash)
	const getStoragePath = (hash) => {
		// for Windows user
		const bucket1 = hash.slice(0, 2).toLowerCase();
		//const bucket2 = hash.slice(2, 4);
		return join(blobDir, bucket1);
	};

	batcher["blob"] = (hash) => {
		const hashBuf = Buffer.from(hash, 'base64url');
		const row = db.prepare('SELECT name, type, size, lastModified FROM blobs WHERE hash = ?').get(hashBuf);
		return row ? row : {error: 'not found'};
	};

	// 文件库接口
	batcher["blob/by-name"] = (name) => {
		const row = db.prepare('SELECT * FROM blobs WHERE indexedName = ?').get(name);
		if (!row) return {error: 'not found'};
		row.hash = Buffer.from(row.hash).toString('base64url');
		return row;
	};
	batcher["blob/set-name"] = ([hash, name]) => {
		const hashBuf = Buffer.from(hash, 'base64url');

		db.exec('BEGIN');
		try {
			db.prepare('UPDATE blobs SET indexedName = NULL WHERE indexedName = ? AND hash != ?').run(name, hashBuf)
			const result = db.prepare('UPDATE blobs SET indexedName = ? WHERE hash = ?').run(name, hashBuf);
			db.exec('COMMIT');
			return result.changes > 0;
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	};

	// 下载 Blob
	router.get('/blob/:hash', async (ctx) => {
		const { hash } = ctx.params;
		const hashBuf = Buffer.from(hash, 'base64url');
		const info = db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hashBuf);
		if (!info) return ctx.send(404, { error: 'not found' });

		const lastModified = new Date(info.lastModified).toUTCString();

		const ifModifiedSince = ctx.req.headers['if-modified-since'];
		if (ifModifiedSince) {
			const imsDate = new Date(ifModifiedSince);
			if (!isNaN(imsDate.getTime()) && info.lastModified <= imsDate) {
				ctx.res.writeHead(304, {
					'Content-Length': 0,
					'Last-Modified': lastModified,
				});
				ctx.res.end();
				return;
			}
		}

		const fileSize = info.size;
		const dataPath = join(getStoragePath(hash), hash);

		// 检查并解析 Range 头
		let range = ctx.req.headers['range'];
		let start, end;

		if (range && !range.includes(',')) {
			const ifRange = ctx.req.headers['if-range'];
			if (ifRange) {
				if (ifRange !== lastModified) range = null;
			}
		} else {
			range = null;
		}

		if (range) {
			const match = range.match(/^bytes=(\d+)-(\d*)$/);
			if (match) {
				start = parseInt(match[1], 10);
				if (match[2] !== '') {
					end = parseInt(match[2], 10);
				} else {
					end = fileSize - 1;
				}
				if (end >= fileSize) end = fileSize - 1;

				// 验证范围
				if (start >= fileSize || start > end) {
					ctx.res.writeHead(416, {
						'Content-Range': `bytes */${fileSize}`,
						'Content-Length': '0',
						'Last-Modified': lastModified
					});
					ctx.res.end();
					return;
				}

				const contentLength = end - start + 1;
				ctx.res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${fileSize}`,
					'Content-Length': contentLength.toString(),
					'Content-Type': info.type,
					'Cache-Control': 'public, max-age=31536000, immutable',
					'Last-Modified': lastModified,
					'Accept-Ranges': 'bytes'
				});

				// 管道部分内容
				await pipeline(createReadStream(dataPath, { start, end }), ctx.res);
				return;
			}
		}

		ctx.res.writeHead(200, {
			'Content-Type': info.type,
			'Content-Length': fileSize,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Last-Modified': lastModified,
			'Accept-Ranges': 'bytes'
		});

		await pipeline(createReadStream(dataPath), ctx.res);
	});

	// 上传 Blob
	router.post('/blob/:hash', async (ctx) => {
		const { hash } = ctx.params;

		const info = db.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hash);
		if (info) return ctx.send(400, { error: "already exist" });

		let tempFile = join(tempDir, `${Math.random().toString(36).slice(2)}.tmp`);
		const hasher = createHash('sha256');
		let fileSize = 0;

		const expectedLength = parseInt(ctx.req.headers["content-length"]);
		if (expectedLength >= MAX_UPLOAD_SIZE) {
			ctx.send(413, { error: 'file too big '+MAX_UPLOAD_SIZE });
			ctx.req.destroy();
			return;
		}

		hasError:
		try {
			const fileStream = createWriteStream(tempFile);
			ctx.req.on('data', chunk => {
				hasher.update(chunk);
				fileSize += chunk.length;

				if (fileSize >= MAX_UPLOAD_SIZE) {
					ctx.send(413, { error: 'file too big '+MAX_UPLOAD_SIZE });
					ctx.req.destroy();
				}
			});
			await pipeline(ctx.req, fileStream);

			const hashBuf = hasher.digest();
			const hashStr = hashBuf.toString('base64url');

			if (hash !== hashStr) {
				ctx.send(400, { error: 'hash error' });
				break hasError;
			}

			const bucket = getStoragePath(hashStr);
			await mkdir(bucket, { recursive: true });

			const targetPath = join(bucket, hashStr);
			await access(targetPath).catch(() => {
				return rename(tempFile, targetPath).then(() => {
					tempFile = null;
				});
			});

			const now = Date.now();
			db.prepare(`
                INSERT INTO blobs (hash, type, name, size, lastModified) 
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
            `).run(
				hashBuf,
				ctx.req.headers['content-type'] || 'application/octet-stream',
				ctx.searchParams.get("name") || '',
				fileSize,
				Math.max(0, Math.min(parseInt(ctx.searchParams.get("time")) || now, now))
			);

			ctx.send(201, { hash });
			return;
		} catch (err) {
			ctx.send(500, { error: err.message });
		}

		if (tempFile) await unlink(tempFile); // 删除重复的临时文件
	});

	/**
	 * 列表接口（支持分页）
	 * GET /blobs?page=1&pageSize=20
	 */
	router.get('/blobs', async (ctx) => {
		const page = Math.max(1, parseInt(ctx.searchParams.get('page')) || 1);
		const pageSize = Math.max(1, Math.min(100, parseInt(ctx.searchParams.get('limit')) || 20));
		const offset = (page - 1) * pageSize;

		try {
			// 1. 获取总数
			const countStmt = db.prepare('SELECT COUNT(*) as total FROM blobs');
			const { total } = countStmt.get();

			// 2. 查询当前页数据
			const listStmt = db.prepare(`
                SELECT *
                FROM blobs 
                ORDER BY lastModified DESC 
                LIMIT ? OFFSET ?
            `);
			const rows = listStmt.all(pageSize, offset);

			// 3. 格式化结果：将 Buffer 类型的 hash 转为 base64url 字符串
			rows.forEach(row => {
				row.hash = Buffer.from(row.hash).toString('base64url')
			});

			ctx.send(200, {
				total,
				data: rows
			});
		} catch (err) {
			ctx.send(500, { error: err.message });
		}
	});

	/**
	 * 删除接口
	 * DELETE /blob/:hash
	 */
	router.delete('/blob/:hash', async (ctx) => {
		const { hash } = ctx.params;
		let hashBuf = Buffer.from(hash, 'base64url');

		// 防止删除任意文件
		const row = db.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hashBuf);
		if (!row) return ctx.send(404, { error: 'not found' });

		const dataPath = join(getStoragePath(hash), hash);

		try {
			await unlink(dataPath);
			db.prepare('DELETE FROM blobs WHERE hash = ?').run(hashBuf);

			ctx.send(200, true);
		} catch (err) {
			ctx.send(500, { error: err.message });
		}
	});
}