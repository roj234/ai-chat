import {LOG_HOOK} from "../config.js";
import {
	compressConversation,
	compressLog,
	compressMessage,
	decompressConversation,
	decompressLog,
	decompressMessage
} from "../utils/compression.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * @param {AiChatBackend.Router} router
 * @param {string} rootPath
 */
export function registerDatabaseRoutes(router, rootPath) {
	router.delete('/database', async (ctx) => {
		const processLog = (async () => {
			const logs = await ctx.logDB;
			const changes = new Map;
			for (let i = Math.max(0, logs.size - 5000); i >= 0; i--) {
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

		const db = ctx.db;
		db.exec("BEGIN;");

		const conversations = db.prepare(`SELECT id, data FROM "conversations"`).all();
		const updateConversation = db.prepare(`UPDATE "conversations" SET data = ? WHERE id = ?`);
		for (const row of conversations) {
			const data = decompressConversation(row.data);
			const result = await compressConversation(data);
			if (Buffer.compare(row.data, result)) updateConversation.run(result, row.id);
		}

		const messages = db.prepare(`SELECT id, data FROM "messages"`).all();
		const updateMessage = db.prepare(`UPDATE "messages" SET data = ? WHERE id = ?`);
		for (const row of messages) {
			const data = decompressMessage(row.data);
			const result = await compressMessage(data);
			if (Buffer.compare(row.data, result)) updateMessage.run(result, row.id);
		}

		/*const kv = ctx.db.prepare(`SELECT key, value FROM "kv"`).all();
		const updateKV = ctx.db.prepare(`UPDATE "kv" SET value = ? WHERE key = ?`);
		for (const row of messages) {
			const data = decompressGeneric(row.value);
			updateMessage.run(await compressGeneric(data), row.key);
		}*/

		db.exec(`COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);`);

		await processLog;

		ctx.send(200, { success: true });
	});

	router.post('/database/fetch', async (ctx) => {
		let sync = 0;
		let zenmuxToken;

		const logs = await ctx.logDB;
		const records = await logs.findByTime(Date.now() - 86400000, Date.now());
		if (records) {
			const changes = new Map;
			for (let i = records.firstId; i <= records.lastId; i++) {
				const row = logs.get(i);
				const logItem = decompressLog(row.data);

				if (logItem.provider === "ZenMux" && null == logItem.cost) {
					if (null == zenmuxToken) zenmuxToken = await fs.readFile(path.join(rootPath, "zenmux-token.txt"));
					if (!zenmuxToken) break;

					const json = (await fetch("https://zenmux.ai/api/v1/management/generation?id="+logItem.request_id, {
						headers: {
							authorization: "Bearer "+zenmuxToken
						}
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
					logItem.cost = json.ratingResponses.billAmount;

					changes.set(i, await compressLog(logItem));
					sync++;
				}
			}

			await logs.update(changes);
		}

		ctx.send(200, { updated: sync });
	});
}