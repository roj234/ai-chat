import {ALLOW_SQL_EXECUTION, LOG_HOOK} from "../config.js";
import {
	compressConversation,
	compressLog,
	compressMessage,
	decompressConversation,
	decompressLog,
	decompressMessage,
	deserializeRow
} from "../utils/compression.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * @param {AiChatBackend.Router} router
 * @param {string} rootPath
 */
export function registerDatabaseRoutes(router, rootPath) {
	router.post('/database', async (ctx) => {
		if (!ALLOW_SQL_EXECUTION) {
			ctx.send(403, { error: "功能未开启" });
			return;
		}

		ctx.db.exec(await ctx.readAsObject(8192).sql);

		ctx.send(200, { success: true });
	});
	router.delete('/database', async (ctx) => {
		const logs = ctx.db.prepare(`SELECT id, data FROM "logs"`).all();
		const updateLog = ctx.db.prepare(`UPDATE "logs" SET data = ? WHERE id = ?`);
		for (const row of logs) {
			const data = decompressLog(row.data);
			LOG_HOOK(data);
			updateLog.run(await compressLog(data), row.id);
		}

		const conversations = ctx.db.prepare(`SELECT id, data FROM "conversations"`).all();
		const updateConversation = ctx.db.prepare(`UPDATE "conversations" SET data = ? WHERE id = ?`);
		for (const row of conversations) {
			const data = decompressConversation(row.data);
			["id", "title", "time"].forEach(key => delete data[key]);
			updateConversation.run(await compressConversation(data), row.id);
		}

		const messages = ctx.db.prepare(`SELECT id, data FROM "messages"`).all();
		const updateMessage = ctx.db.prepare(`UPDATE "messages" SET data = ? WHERE id = ?`);
		for (const row of messages) {
			const data = decompressMessage(row.data);
			["id", "owner", "time"].forEach(key => delete data[key]);
			updateMessage.run(await compressMessage(data), row.id);
		}

		/*const kv = ctx.db.prepare(`SELECT key, value FROM "kv"`).all();
		const updateKV = ctx.db.prepare(`UPDATE "kv" SET value = ? WHERE key = ?`);
		for (const row of messages) {
			const data = decompressGeneric(row.value);
			updateMessage.run(await compressGeneric(data), row.key);
		}*/

		ctx.db.exec('VACUUM');
		ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		ctx.send(200, { success: true });
	});

	router.post('/database/fetch', async (ctx) => {
		const rows = ctx.db.prepare(`SELECT * FROM "logs"`).all();
		const updateData = ctx.db.prepare(`UPDATE "logs" SET data = ? WHERE id = ?`);
		const zenmuxToken = await fs.readFile(path.join(rootPath, "zenmux-token.txt"));

		let sync = 0;
		for (const row of rows) {
			const {id, time, ...logItem} = deserializeRow(row, decompressLog);

			if (logItem.provider === "ZenMux" && null == logItem.cost) {
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

				updateData.run(await compressLog(logItem), row.id);
				sync++;
			}
		}

		ctx.send(200, { updated: sync });
	});
}