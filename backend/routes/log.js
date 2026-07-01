import {compressLog, decompressLog, deserializeRow} from "../utils/compression.js";
import {LOG_HOOK} from "../config.js";

/**
 * @param {AiChatBackend.Router} router
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 */
export function registerLogRoutes(router, batcher) {
	router.get('/logs', (ctx) => {
		const start = Number(ctx.query.start) || 0;
		const end = Number(ctx.query.end) || Date.now();
		const rows = ctx.db.prepare('SELECT data, time, ROWID FROM logs WHERE time >= ? AND time <= ? ORDER BY time DESC LIMIT 5000').all(start, end);
		ctx.send(200, rows.map(row => {
			const data = deserializeRow(row, decompressLog);
			delete data.request_id;
			delete data.usage;
			return data;
		}));
	});
	batcher['log/by-rowid'] = (id, {db}) => {
		if (!Number.isFinite(id)) return { error: "illegal id" };
		const row = db.prepare('SELECT id, data, time FROM logs WHERE ROWID = ?').get(id);
		return row ? deserializeRow(row, decompressLog) : null;
	};

	batcher['log'] = (id, {db}) => {
		if (!Number.isFinite(id)) return { error: "illegal id" };
		const row = db.prepare('SELECT data, time FROM logs WHERE id = ?').get(id);
		return row ? deserializeRow(row, decompressLog) : null;
	};

	batcher['log/insert'] = async ({id, time = Date.now(), ...body}, ctx) => {
		if (id < 0) id = null;
		id = id ?? await ctx.getVariable("messageId");
		if (time == null) return { error: 'id required' };

		const result = await LOG_HOOK(body);
		if (result === 'SKIP') return false;

		ctx.db.prepare('INSERT INTO logs (id, time, data) VALUES (?, ?, ?)').run(id, time, await compressLog(body));
		return true;
	};
}