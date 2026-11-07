import {dirname, join} from 'node:path';
import {createWriteStream, readdirSync} from 'node:fs';
import {link, mkdir, rename, rm, rmdir, unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';

import {DatabaseSync} from 'node:sqlite';
import {cachePreparedSql} from "../utils/sqliteUtils.js";
import {ADMIN_USER_NAMES, ALLOW_USER_NAMES, MAX_UPLOAD_SIZE, RESTRICT_USER_CREATION} from "../config.js";
import {exclusiveLock} from "../utils/lock.js";
import {safeStat, serveFile} from "@roj234/ie/utils/serveFile.js";

export const BLOB_HASH_REGEX = "[a-zA-Z0-9_-]{43}";

/** @type {DatabaseSync} */
export let blobDB;

const DB_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
    hash BLOB PRIMARY KEY,
    type TEXT NOT NULL,
    size INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS blob_refs (
    user TEXT NOT NULL,
    hash BLOB NOT NULL,
    name TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (user, hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS blob_refs_hash ON blob_refs (hash);
CREATE INDEX IF NOT EXISTS blob_refs_recent ON blob_refs (user, created DESC);
`;

/**
 * 从数据目录里枚举所有用户（用户库为 <userId>.db）
 * @param {string} dataPath
 * @return {string[]}
 */
function listUsers(dataPath) {
	const entries = readdirSync(dataPath, {withFileTypes: true});
	const users = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.db')) continue;

		const user = entry.name.slice(0, -3);
		if (!user || user === 'index' || user.endsWith('_rag')) continue;
		if (RESTRICT_USER_CREATION ? !ALLOW_USER_NAMES.test(user) : /[\s\\/:*?<>|]/.test(user)) continue;
		users.push(user);
	}
	return users;
}

/**
 * @param {AiChatBackend.Router} router
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 * @param {string} blobDir
 */
export function registerBlobRoutes(router, batcher, blobDir) {
	const tempDir = join(blobDir, ".tmp");
	const dbPath = join(blobDir, 'index.db');
	const dataPath = dirname(blobDir);

	rm(tempDir, { recursive: true, force: true })
	.then(() => mkdir(tempDir, { recursive: true }))
	.then(() => {
		blobDB = new DatabaseSync(dbPath);
		const { user_version } = blobDB.prepare('PRAGMA user_version').get();
		cachePreparedSql(blobDB);

		if (user_version === 0) {
			blobDB.exec(SCHEMA+`
PRAGMA user_version = `+DB_VERSION);
		} else if (user_version < DB_VERSION) {
			if (user_version <= 1) {
				blobDB.exec('BEGIN IMMEDIATE;\n'+SCHEMA);

				const backfill = blobDB.prepare(`INSERT INTO blob_refs (user, hash, name, created) SELECT ?, hash, name, lastModified FROM blobs`);
				for (const user of listUsers(dataPath)) backfill.run(user);

				blobDB.exec(`
CREATE TABLE blobs2 (
    hash BLOB PRIMARY KEY,
    type TEXT NOT NULL,
    size INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO blobs2 (hash, size, type) SELECT hash, size, type FROM blobs;
DROP TABLE blobs;
ALTER TABLE blobs2 RENAME TO blobs;

COMMIT;`)
			}

			blobDB.exec(`PRAGMA user_version = `+DB_VERSION);
		}

		// TODO 每次启动读用户列表，并删掉那些已经被删除的用户（？）
	});

	// 辅助函数：获取分桶路径 (例如: ab/hash)
	const getStoragePath = (hash) => join(blobDir, hash.slice(0, 2).toLowerCase());
	const getFilePath = (hash) => join(getStoragePath(hash), hash);

	// 获取 Blob 元数据
	batcher["blob"] = ([hash, name], ctx) => {
		if (typeof hash !== 'string' || !new RegExp(`^${BLOB_HASH_REGEX}$`).test(hash)) {
			return {error: 'invalid hash'};
		}

		const hashBuf = Buffer.from(hash, 'base64url');
		const userId = ctx.params.userId;
		const now = Date.now();

		const blob = blobDB.prepare('SELECT type, size FROM blobs WHERE hash = ?').get(hashBuf);
		if (!blob) return {error: 'not found'};

		const ref = blobDB.prepare(`SELECT * FROM blob_refs WHERE user = ? AND hash = ?`).get(userId, hashBuf);
		if (ref) {
			if (!ref.name && name) blobDB.prepare('UPDATE blob_refs SET name = ? WHERE user = ? AND hash = ?').run(name, userId, hashBuf);

			return {
				name: ref.name || name,
				type: blob.type,
				size: blob.size,
				lastModified: ref.created
			};
		}

		if (typeof name !== 'string') return { error: 'not found' };

		blobDB.prepare(`INSERT OR IGNORE INTO blob_refs (user, hash, name, created) VALUES (?, ?, ?, ?)`).run(userId, hashBuf, name, now);

		return {
			name,
			type: blob.type,
			size: blob.size,
			lastModified: now
		};
	};

	// 下载 Blob
	router.get(`/blob/:hash(${BLOB_HASH_REGEX})`, async (ctx) => {
		const { hash, userId } = ctx.params;

		const info = blobDB.prepare(`
SELECT b.size, b.type, r.name, r.created AS lastModified
FROM blob_refs r JOIN blobs b ON b.hash = r.hash
WHERE r.user = ? AND r.hash = ?`).get(userId, Buffer.from(hash, 'base64url'));

		if (!info) return ctx.send(404);
		await serveFile(ctx, info, getFilePath(hash));
	});

	// 上传 Blob
	router.post(`/blob/:hash(${BLOB_HASH_REGEX})`, async (ctx) => {
		const { hash, userId } = ctx.params;
		const hashBuf = Buffer.from(hash, 'base64url');

		const info = blobDB.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hashBuf);
		if (info) return ctx.send(409, { error: { type: "FILE_ALREADY_EXIST" } });

		let contentType = ctx.req.headers['content-type'];
		// 允许不提供，不提供时用 octet-stream
		if (contentType) {
			if (contentType.length > 128 ||
				!/^[a-z]+\/[a-z0-9\-_+.]+$/.test(contentType = contentType.split(";", 1)[0].trim().toLowerCase())
			) {
				return ctx.send(400, { error: { type: "PARAM_ERROR", details: 'invalid content-type' } });
			}
		}

		const expectedLength = parseInt(ctx.req.headers["content-length"]);
		if (expectedLength >= MAX_UPLOAD_SIZE) {
			ctx.send(413, { error: { type: "FILE_TOO_BIG", details: `${expectedLength} > ${MAX_UPLOAD_SIZE}` } });
			ctx.req.destroy();
			return;
		}

		let tempFile = join(tempDir, `${crypto.randomUUID()}.tmp`);
		let fileSize = 0;
		const hasher = createHash('sha256');

		try {
			const fileStream = createWriteStream(tempFile);
			ctx.req.on('data', chunk => {
				hasher.update(chunk);
				fileSize += chunk.length;

				if (fileSize >= MAX_UPLOAD_SIZE) {
					ctx.send(413, { error: { type: "FILE_TOO_BIG", details: `${expectedLength} > ${MAX_UPLOAD_SIZE}` } });
					ctx.req.destroy();
				}
			});
			await pipeline(ctx.req, fileStream);

			const digest2 = hasher.digest();
			if (Buffer.compare(hashBuf, digest2) !== 0) {
				return ctx.send(400, { type: "PARAM_ERROR", details: 'Digest mismatch' });
			}

			const bucket = getStoragePath(hash);
			await mkdir(bucket, { recursive: true });
			await link(tempFile, getFilePath(hash)).catch(async (err) => {
				if (err.code === 'EEXIST') return;
				if (!(await safeStat(getFilePath(hash))).notExist) return;
				if (err.code === 'EPERM' || err.code === 'ENOTSUP' || err.code === 'EXDEV') {
					return rename(tempFile, getFilePath(hash));
				}
				throw err;
			});

			const now = Date.now();
			const time = Math.max(0, Math.min(parseInt(ctx.searchParams.get("time")) || now, now));
			const name = ctx.searchParams.get("name") || '';

			blobDB.prepare(`INSERT OR IGNORE INTO blobs (hash, size, type) VALUES (?, ?, ?)`).run(hashBuf, fileSize, contentType || '');
			blobDB.prepare(`INSERT OR IGNORE INTO blob_refs (user, hash, name, created) VALUES (?, ?, ?, ?)`).run(userId, hashBuf, name, time);

			ctx.send(201, {hash});
		} catch (err) {
			ctx.send(500, {error: err.message});
		} finally {
			await unlink(tempFile).catch(() => {});
		}
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
		const all = params.get('all');

		const conds = [];
		const args = [];
		if (!all) {
			conds.push('r.user = ?');
			args.push(ctx.params.userId);
		} else if (!ADMIN_USER_NAMES.test(ctx.params.userId)) {
			return ctx.send(403);
		}

		if (term) {
			if (new RegExp(`^${BLOB_HASH_REGEX}$`).test(term)) {
				conds.push('r.hash = ?');
				args.push(Buffer.from(term, 'base64url'));
			} else {
				conds.push('r.name LIKE ?');
				args.push(`%${term}%`);
			}
		}

		const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

		try {
			// 1. 获取总数
			const {total} = blobDB.prepare(`
SELECT COUNT(*) as total 
FROM blob_refs r` + where).get(...args);

			// 2. 查询当前页数据
			const rows = blobDB.prepare(`
SELECT ${all ? 'r.user, ' : ''}r.hash, r.name, r.created AS lastModified, b.size, b.type
FROM blob_refs r JOIN blobs b ON b.hash = r.hash
${where}
ORDER BY r.created DESC 
LIMIT ? OFFSET ?`).all(...args, pageSize, offset);

			// 3. 格式化结果：将 Buffer 类型的 hash 转为 base64url 字符串
			rows.forEach(row => {
				row.hash = Buffer.from(row.hash).toString('base64url');
			});

			ctx.send(200, {
				total,
				data: rows
			});
		} catch (err) {
			ctx.send(500, { error: err.message });
		}
	}, true));

	/**
	 * 删除 Blob
	 * @param {string} hash
	 * @param {AiChatBackend.RouteContext} ctx
	 * @param {string} [user] 这个参数现在只通过 delete 接口传
	 */
	const handleDeleteBlob = batcher["blob/del"] = async (hash, ctx, user) => {
		let hashBuf = Buffer.from(hash, 'base64url');
		let userId = ctx.params.userId;

		if (user && ADMIN_USER_NAMES.test(userId)) {
			userId = user;
		}

		const deleted = blobDB.prepare('DELETE FROM blob_refs WHERE user = ? AND hash = ?').run(userId, hashBuf).changes;
		if (!deleted) return {error: 'not found'};

		if (!blobDB.prepare('SELECT 1 FROM blob_refs WHERE hash = ? LIMIT 1').get(hashBuf)) {
			blobDB.prepare('DELETE FROM blobs WHERE hash = ?').run(hashBuf);

			await unlink(getFilePath(hash)).catch(err => {
				if (err.code !== 'ENOENT') throw err;
			});
			// 避免残留空目录
			await rmdir(getStoragePath(hash)).catch(() => {});
		}

		return true;
	};

	router.delete(`/blob/:hash(${BLOB_HASH_REGEX})`, async (ctx) => {
		try {
			const val = await handleDeleteBlob(ctx.params.hash, ctx, ctx.searchParams.get('user'));
			ctx.send(200, val);
		} catch (err) {
			ctx.send(500, {error: err.message});
		}
	});
}