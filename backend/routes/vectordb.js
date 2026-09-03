import path from "node:path";
import fs from "node:fs/promises";
import {VectorDB} from "../rag/VectorDB.js";
import {LRUCache} from "../../common/LRUCache.js";
import {SEMANTIC_SEARCH_EMBEDDING_SIZE} from "../config.js";
import {pathFilter} from "./agent.js";

const MAX_OPEN_DBS = 64;

/**
 * 请注意：API 后续可能会变
 * @param {AiChatBackend.Router} router
 * @param {string} dataPath
 */
export function registerVectorDBRoutes(router, dataPath) {
	/**
	 * 向量库缓存：LRU 驱逐时自动关闭句柄
	 * @type {LRUCache<string, VectorDB>}
	 */
	const dbCache = new LRUCache(MAX_OPEN_DBS, (db) => {
		db.close().catch(e => console.error("VectorDB close error:", e));
	});

	/** 获取或打开一个命名向量库 */
	async function getDB(ctx, dbName, dimension) {
		const userId = ctx.params.userId;
		if (!userId) throw Object.assign(new Error("missing userId"), { statusCode: 400 });

		const key = ctx.fsRoot+'\0'+dbName;
		let db = dbCache.get(key);
		if (!db) {
			const filePath = pathFilter(`vectors/${dbName}.db`, ctx);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			db = new VectorDB(filePath, dimension ?? SEMANTIC_SEARCH_EMBEDDING_SIZE);
			dbCache.set(key, db, 0);
		}
		return db;
	}

	/** 检查库名合法性 */
	function validateName(name) {
		if (typeof name !== "string") return false;
		return /^[a-zA-Z0-9_-]{3,64}$/.test(name);
	}

	// ──── 列出所有库 ──────────────────────────────────

	router.post("/vectordb/list", async (ctx) => {
		const userId = ctx.params.userId;
		if (!userId) return ctx.send(400, { error: "missing userId" });

		const dir = path.join(ctx.fsRoot, `vectors`);

		const databases = [];
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;

				const dbName = entry.name.slice(0, -3);
				const stat = await fs.stat(path.join(entry.parentPath, entry.name));

				// 尝试获取缓存的 size，没有则返回 0
				const key = ctx.fsRoot+'\0'+dbName;
				const cached = dbCache.get(key);
				databases.push({
					name: dbName,
					vectors: cached?.size ?? 0,
					dimension: cached?.dimension ?? SEMANTIC_SEARCH_EMBEDDING_SIZE,
					fileSize: stat.size,
				});
			}
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}

		ctx.send(200, databases);
	});

	// ──── 创建/打开库 ──────────────────────────────────

	router.post("/vectordb/create", async (ctx) => {
		const { name, dimension } = await ctx.readAsObject();
		if (!validateName(name)) {
			return ctx.send(400, { error: "invalid name: must be 1-64 chars, [a-zA-Z0-9_.-]" });
		}
		if (dimension != null && (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192)) {
			return ctx.send(400, { error: "invalid dimension: must be 1-8192" });
		}

		const db = await getDB(ctx, name, dimension);
		ctx.send(200, { name, dimension: db.dimension });
	});

	// ──── 批量插入/更新 ───────────────────────────────

	router.post("/vectordb/insert", async (ctx) => {
		const { db: dbName, entries } = await ctx.readAsObject();
		if (!validateName(dbName)) return ctx.send(400, { error: "invalid db name" });
		if (!Array.isArray(entries) || entries.length === 0) {
			return ctx.send(400, { error: "entries must be a non-empty array" });
		}

		const db = await getDB(ctx, dbName);

		// 并发限制
		const CONCURRENCY = 8;
		let inserted = 0;
		let index = 0;

		async function worker() {
			while (index < entries.length) {
				const i = index++;
				const entry = entries[i];
				if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") continue;
				try {
					await db.set(entry.id, entry.text);
					inserted++;
				} catch (e) {
					console.error(`vectordb insert failed for "${entry.id}":`, e.message);
				}
			}
		}

		const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker());
		await Promise.all(workers);

		ctx.send(200, { inserted });
	});

	// ──── 批量删除 ────────────────────────────────────

	router.post("/vectordb/delete", async (ctx) => {
		const { db: dbName, ids } = await ctx.readAsObject();
		if (!validateName(dbName)) return ctx.send(400, { error: "invalid db name" });
		if (!Array.isArray(ids) || ids.length === 0) {
			return ctx.send(400, { error: "ids must be a non-empty array" });
		}

		const db = await getDB(ctx, dbName);
		let deleted = 0;
		for (const id of ids) {
			if (typeof id !== "string") continue;
			await db.delete(id);
			deleted++;
		}

		ctx.send(200, { deleted });
	});

	// ──── 语义查询 ────────────────────────────────────

	router.post("/vectordb/query", async (ctx) => {
		const { db: dbName, text, topK = 5, threshold = 0.3 } = await ctx.readAsObject();
		if (!validateName(dbName)) return ctx.send(400, { error: "invalid db name" });
		if (!text || typeof text !== "string") return ctx.send(400, { error: "text required" });

		const db = await getDB(ctx, dbName);
		const results = await db.query(text, topK, threshold);

		ctx.send(200, results);
	});

	// ──── 库信息 ──────────────────────────────────────

	router.post("/vectordb/info", async (ctx) => {
		const { db: dbName } = await ctx.readAsObject();
		if (!validateName(dbName)) return ctx.send(400, { error: "invalid db name" });

		const db = dbCache.get(ctx.fsRoot+'\0'+dbName);
		if (!db) {
			const filePath = pathFilter(`vectors/${dbName}.db`, ctx.fsRoot);
			let fileSize = 0;
			try {
				fileSize = (await fs.stat(filePath)).size;
			} catch (e) {
				if (e.code === "ENOENT") return ctx.send(404, { error: "database not found" });
				throw e;
			}
			return ctx.send(200, {
				name: dbName,
				size: 0,
				dimension: SEMANTIC_SEARCH_EMBEDDING_SIZE,
				fileSize,
				opened: false,
			});
		}

		ctx.send(200, {
			name: dbName,
			size: db.size,
			dimension: db.dimension,
			opened: true,
		});
	});

	// ──── 删库 ────────────────────────────────────────

	router.post("/vectordb/drop", async (ctx) => {
		const { db: dbName } = await ctx.readAsObject();
		if (!validateName(dbName)) return ctx.send(400, { error: "invalid db name" });

		// 先关句柄再从缓存移除
		const key = ctx.fsRoot+'\0'+dbName;
		const db = dbCache.get(key);
		if (db) {
			await db.close();
			dbCache.delete(key);
		}

		// 删除文件
		const filePath = pathFilter(`vectors/${dbName}.db`, ctx.fsRoot);
		try {
			await fs.unlink(filePath);
		} catch (e) {
			if (e.code !== "ENOENT") throw e;
		}

		ctx.send(200, { success: true });
	});
}
