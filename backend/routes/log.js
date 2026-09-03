import {compressLog, decompressLog, deserializeRow} from "../utils/compression.js";
import {LOG_HOOK} from "../config.js";

/**
 * @param {AiChatBackend.Router} router
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 */
export function registerLogRoutes(router, batcher) {
	batcher['logs'] = async ([start = 0, end = Date.now(), lastRow], ctx) => {
		if (!Number.isFinite(start) || !Number.isFinite(end) ||(lastRow && !Number.isFinite(lastRow))) return { error: "illegal params" };
		const tsdb = await ctx.logDB;
		const range = await tsdb.findByTime(start, end);
		if (!range) return [];

		// TODO optimize this to use lastRow.
		const rows = [];
		const idx = Math.max(range.firstId, range.lastId - 4999);
		for (let i = range.lastId; i >= idx; i--) {
			const row = await tsdb.get(i);
			const data = deserializeRow(row, decompressLog);
			delete data.request_id;
			delete data.usage;
			rows.push(data);
		}

		return rows;
	};

	batcher['log/by-rowid'] = async (id, ctx) => {
		if (!Number.isFinite(id)) return { error: "illegal id" };
		const tsdb = await ctx.logDB;
		const row = await tsdb.get(id);
		return row ? deserializeRow(row, decompressLog) : null;
	};

	batcher['log'] = async (id, ctx) => {
		if (!Number.isFinite(id)) return { error: "illegal id" };
		const tsdb = await ctx.logDB;
		const row = await tsdb.getByOwnerId(id);
		return row ? deserializeRow(row, decompressLog) : null;
	};

	batcher['log/insert'] = async ({id, time = Date.now(), ...body}, ctx) => {
		if (id < 0) id = null;
		id = id ?? await ctx.getVariable("messageId");
		if (time == null) return { error: 'id required' };

		const result = await LOG_HOOK(body);
		if (result === 'SKIP') return false;

		if (typeof id !== 'number') {
			body.id = id;
			id = undefined;
		}

		const tsdb = await ctx.logDB;
		await tsdb.append(await compressLog(body), id, time);
		return true;
	};
}