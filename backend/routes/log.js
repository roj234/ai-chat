import {jsonParse} from '../utils.js';

export function registerLogRoutes(router) {
	router.get('/logs', (ctx) => {
		const start = Number(ctx.query.start) || 0;
		const end = Number(ctx.query.end) || Date.now();
		const rows = ctx.db.prepare('SELECT * FROM statistics WHERE time >= ? AND time <= ? ORDER BY time DESC LIMIT 1000').all(start, end);
		ctx.send(200, rows.map(row => {
			const str = row.data;
			delete row.data;
			return jsonParse(str, row);
		}));
	});

	router.get('/log/:message_id', (ctx) => {
		const msgId = Number(ctx.params.message_id);
		const row = ctx.db.prepare('SELECT data, time FROM statistics WHERE message_id = ?').get(msgId);
		ctx.send(200, row ? jsonParse(row.data, {time: row.time}) : null);
	});

	router.post('/log', async (ctx) => {
		const body = await ctx.readBody();
		const messageId = body.message_id;
		const time = body.time || Date.now();
		if (messageId == null) return ctx.send(400, { error: 'message_id required' });

		delete body.message_id;
		delete body.time;

		ctx.db.prepare('INSERT OR REPLACE INTO statistics (message_id, time, data) VALUES (?, ?, ?)')
			.run(messageId, time, JSON.stringify(body));
		ctx.send(201, { success: true });
	});
}