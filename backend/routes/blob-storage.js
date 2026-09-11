import {join} from 'node:path';
import {createReadStream, createWriteStream} from 'node:fs';
import {access, mkdir, rename, rm, unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';

import {DatabaseSync} from 'node:sqlite';
import {cachePreparedSql} from "../utils/sqliteUtils.js";
import {MAX_UPLOAD_SIZE} from "../config.js";
import {exclusiveLock} from "../utils/lock.js";

export const BLOB_HASH_REGEX = "[a-zA-Z0-9_-]{43}";

/** @type {DatabaseSync} */
export let blobDB;

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

	rm(tempDir, { recursive: true, force: true })
	.then(() => mkdir(tempDir, { recursive: true }))
	.then(() => {
		blobDB = new DatabaseSync(dbPath);
		const { user_version } = blobDB.prepare('PRAGMA user_version').get();
		cachePreparedSql(blobDB);

		if (user_version === 0) {
			blobDB.exec(`
CREATE TABLE blobs (
    hash BLOB PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    lastModified INTEGER NOT NULL
) WITHOUT ROWID;
PRAGMA user_version = `+DB_VERSION);
		} else if (user_version < DB_VERSION) {
			if (user_version <= 1) {

			}

			blobDB.exec(`PRAGMA user_version = `+DB_VERSION);
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
		const row = blobDB.prepare('SELECT name, type, size, lastModified FROM blobs WHERE hash = ?').get(hashBuf);
		return row ? row : {error: 'not found'};
	};
	// 下载 Blob
	router.get(`/blob/:hash(${BLOB_HASH_REGEX})`, async (ctx) => {
		const { hash } = ctx.params;
		const hashBuf = Buffer.from(hash, 'base64url');
		const info = blobDB.prepare('SELECT * FROM blobs WHERE hash = ?').get(hashBuf);
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
		const fileType = info.type || "application/octet-stream";
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
			}

			if (!match || start < 0 || start >= fileSize || end >= fileSize || start > end) {
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
				'Content-Type': fileType,
				'Cache-Control': 'public, max-age=31536000, immutable',
				'Last-Modified': lastModified,
				'Accept-Ranges': 'bytes'
			});

			// 管道部分内容
			await pipeline(createReadStream(dataPath, { start, end }), ctx.res);
			return;

		}

		ctx.res.writeHead(200, {
			'Content-Type': fileType,
			'Content-Length': fileSize,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Content-Disposition': `attachment; filename="${encodeURIComponent(ctx.searchParams.get("name") || info.name)}"`,
			'Last-Modified': lastModified,
			'Accept-Ranges': 'bytes'
		});

		await pipeline(createReadStream(dataPath), ctx.res);
	});

	// 上传 Blob
	router.post(`/blob/:hash(${BLOB_HASH_REGEX})`, async (ctx) => {
		const { hash } = ctx.params;

		const info = blobDB.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hash);
		if (info) return ctx.send(409, { error: "already exist" });

		let contentType = ctx.req.headers['content-type'];
		// 允许不提供，不提供时用 octet-stream
		if (contentType) {
			if (contentType.length > 128 ||
				!/^[a-z]+\/[a-z0-9\-_+.]+$/.test(contentType = contentType.split(";", 1)[0].trim().toLowerCase())
			) {
				return ctx.send(400, { error: 'invalid content-type' });
			}
		}

		let tempFile = join(tempDir, `${crypto.randomUUID()}.tmp`);
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
				ctx.send(409, { error: 'hash mismatch' });
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
			blobDB.prepare(`
                INSERT INTO blobs (hash, type, name, size, lastModified) 
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING
            `).run(
				hashBuf,
				contentType || '',
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
	router.get('/blobs', exclusiveLock(async (ctx) => {
		const params = ctx.searchParams;
		const page = Math.max(1, parseInt(params.get('page')) || 1);
		const pageSize = Math.max(1, Math.min(100, parseInt(params.get('limit')) || 20));
		const offset = (page - 1) * pageSize;
		const term = params.get("term");

		let isHash;
		const where = term ? (isHash = new RegExp(BLOB_HASH_REGEX).test(term)) ? " WHERE hash = ?" : " WHERE name LIKE ?" : '';
		const whereArg = term ? [isHash ? Buffer.from(term, 'base64url') : `%${term}%`] : [];

		try {
			// 1. 获取总数
			const countStmt = blobDB.prepare('SELECT COUNT(*) as total FROM blobs' + where);
			const { total } = countStmt.get(...whereArg);

			// 2. 查询当前页数据
			const listStmt = blobDB.prepare(`
                SELECT *
                FROM blobs 
                ${where}
                ORDER BY lastModified DESC 
                LIMIT ? OFFSET ?
            `);
			const rows = listStmt.all(...whereArg, pageSize, offset);

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
	}, true));

	// 删除 Blob
	const handleDeleteBlob = batcher["blob/del"] = async (hash, ctx) => {
		let hashBuf = Buffer.from(hash, 'base64url');

		// 防止删除任意文件
		const row = blobDB.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hashBuf);
		if (!row) return {error: 'not found'};

		const dataPath = join(getStoragePath(hash), hash);

		await unlink(dataPath);
		blobDB.prepare('DELETE FROM blobs WHERE hash = ?').run(hashBuf);

		// 避免残留空目录
		await rm(getStoragePath(hash)).catch(() => {});

		return true;
	}

	router.delete(`/blob/:hash(${BLOB_HASH_REGEX})`,  async (ctx) => {
		try {
			const val = await handleDeleteBlob(ctx.params.hash, ctx);
			ctx.send(200, val);
		} catch (err) {
			ctx.send(500, {error: err.message});
		}
	});
}