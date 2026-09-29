import {LOG_HOOK} from "../config.js";
import {
	compressConversation,
	compressKVS,
	compressLog,
	compressMessage,
	decompressConversation,
	decompressLog,
	decompressMessage,
	decompressorKVS
} from "../utils/compression.js";
import fs from "node:fs/promises";
import path from "node:path";
import {LLM_COST_SCALE} from "../sync.js";
import {getProxyAgent} from "../utils/socks5-agent.js";
import {exclusiveLock} from "../utils/lock.js";

/**
 * 重新映射向量数据库的key
 * @param {import("../rag/VectorDB.js").VectorDB} vectorDB
 * @param {Map<number, number>} idMap 旧 message id → 新 message id
 */
async function remapVectorKeys(vectorDB, idMap) {
	await vectorDB.ready;

	/** @type {Promise[]} */
	const del = [];
	const ren = [];

	for (const key of vectorDB.index.keys()) {
		if (!key.startsWith('m#')) continue;

		const oldId = parseInt(key.slice(2), 36);
		const newId = idMap.get(oldId);
		if (newId === undefined) del.push(vectorDB.delete(key));
		else if (newId !== oldId) ren.push([key, 'm#' + newId.toString(36), oldId]);
	}

	// 虽然现在内部是串行的，但说不定未来就fine-grained lock并行了呢
	await Promise.all(del);

	ren.sort((a, b) => a[2] - b[2]);
	for (const [from, to] of ren) {
		await vectorDB.rename(from, to);
	}
}

/**
 * @param {AiChatBackend.Router} router
 * @param {string} rootPath
 */
export function registerDatabaseRoutes(router, rootPath) {
	router.delete('/database', exclusiveLock(async (ctx) => {
		const db = ctx.db;
		const logs = await ctx.logDB;

		const processLog = (async () => {
			const changes = new Map;
			for (let i = Math.max(0, logs.size - 5000); i < logs.size; i++) {
				const row = await logs.get(i);
				const data = decompressLog(row.data);
				const choice = await LOG_HOOK(data);
				if (choice === 'SKIP') {
					changes.set(i, null);
					continue;
				}

				const result = await compressLog(data);
				if (Buffer.compare(row.data, result)) changes.set(i, result);
			}

			await logs.update(changes);
		})();

		db.exec("BEGIN;");

		let changed = 0;
		const startTime = Date.now();

		console.log("[数据库整理] 开始整理");

		const conversations = db.prepare(`SELECT id, data FROM "conversations"`).all();
		const updateConversation = db.prepare(`UPDATE "conversations" SET data = ? WHERE id = ?`);
		for (const row of conversations) {
			const data = decompressConversation(row.data);
			const result = await compressConversation(data);
			if (Buffer.compare(row.data, result)) {
				changed++;
				updateConversation.run(result, row.id);
			}
		}

		console.log(`[数据库整理] 整理对话: ${changed} / ${conversations.length}`);

		let firstChanged = 0;

		const max = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`).get()?.seq ?? 0;
		const messageIds = new Uint32Array(max+1);
		/** @type {Map<number, number>} */
		const alive = new Map;

		let exceptedNext = 1;
		let idCount = 1;

		changed = 0;
		const messages = db.prepare(`SELECT id, data FROM "messages" ORDER BY id`).all();
		const updateMessage = db.prepare(`UPDATE "messages" SET data = ?, id = ? WHERE id = ?`);
		for (const row of messages) {
			const id = row.id;
			if (id !== exceptedNext) {
				if (!firstChanged) firstChanged = exceptedNext;
				const gapId = idCount++;
				for (let i = exceptedNext; i < id; i++) messageIds[i] = gapId;
			}
			exceptedNext = id + 1;

			const newId = idCount++;
			messageIds[id] = newId;
			alive.set(id, newId);

			const data = decompressMessage(row.data);
			const result = await compressMessage(data);
			if (Buffer.compare(row.data, result) || id !== newId) {
				updateMessage.run(result, newId, id);
				changed++;
			}
		}

		if (max >= exceptedNext) {
			if (!firstChanged) firstChanged = exceptedNext;
			const gapId = idCount++;
			for (let i = exceptedNext; i <= max; i++) messageIds[i] = gapId;
		}

		db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'messages'`).run(idCount - 1);
		console.log(`[数据库整理] 消息 ${changed} / `+alive.size+", 删除导致的 gap="+(idCount - alive.size - 1));

		changed = 0;
		const kvs = ctx.db.prepare(`SELECT type, name, data FROM "kvs"`).all();
		const updateKVS = ctx.db.prepare(`UPDATE "kvs" SET data = ? WHERE type = ? AND name = ?`);
		for (const {type, data, name} of kvs) {
			const bytes = decompressorKVS(type)(data);
			const result = await compressKVS(bytes, type);
			if (Buffer.compare(data, result)) {
				updateKVS.run(result, type, name);
				changed++;
			}
		}
		console.log(`[数据库整理] 处理的KVS条目: ${changed} / ${kvs.length}`);

		db.exec(`COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);`);

		await processLog;
		if (firstChanged > 0) {
			if (ctx.vectorDB) await remapVectorKeys(ctx.vectorDB, alive);

			const remapped = await logs.remapOwners(owner => messageIds[owner] ?? owner, firstChanged);
			console.log("[数据库整理] 修改了 "+remapped+" 条日志索引");
		}

		console.log(`[数据库整理] 耗时: ${Date.now() - startTime}ms`);

		ctx.send(200, { success: true });
	}));

	router.post('/database/fetch', exclusiveLock(async (ctx) => {
		let sync = 0;
		let zenmuxToken, zenmuxProxy;

		const logs = await ctx.logDB;
		const records = await logs.findByTime(Date.now() - 7 * 86400000, Date.now());
		if (records) {
			const changes = new Map;
			for (let i = records.firstId; i <= records.lastId; i++) {
				const row = await logs.get(i);
				const logItem = decompressLog(row.data);

				if (logItem.provider === "ZenMux" && logItem.cost == null) {
					if (null == zenmuxToken) {
						zenmuxToken = (await fs.readFile(path.join(rootPath, "zenmux-token.txt"), "utf-8")).trim();
						if (!zenmuxToken) break;

						const pos = zenmuxToken.indexOf('\n');
						if (pos > 0) {
							zenmuxProxy = zenmuxToken.slice(pos+1);
							zenmuxToken = zenmuxToken.slice(0, pos).trim();
						}
					}

					const json = (await fetch("https://zenmux.ai/api/v1/management/generation?id="+logItem.request_id, {
						headers: { authorization: "Bearer "+zenmuxToken },
						agent: getProxyAgent(zenmuxProxy)
					}).then(r => r.json())).data;

					let {
						prompt_tokens, prompt_tokens_details = {},
						completion_tokens, completion_tokens_details = {},
					} = json.nativeTokens;

					const {reasoning_tokens = 0} = completion_tokens_details;
					const {cached_tokens = 0, cache_write_tokens = 0} = prompt_tokens_details;

					logItem.input_tokens = prompt_tokens - cached_tokens;
					logItem.output_tokens = completion_tokens;

					logItem.duration = json.generationTime;
					logItem.latency = json.latency;

					if (cached_tokens) logItem.cached_tokens = cached_tokens;
					if (reasoning_tokens) logItem.reasoning_tokens = reasoning_tokens;
					logItem.currency = "USD";
					logItem.cost = Math.round(json.ratingResponses.billAmount * LLM_COST_SCALE);

					changes.set(i, await compressLog(logItem));
					sync++;
				}
			}

			await logs.update(changes);
		}

		ctx.send(200, { updated: sync });
	}, true));
}