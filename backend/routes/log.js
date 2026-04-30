import {jsonParse} from '../utils.js';

export function registerBillingRoutes(router) {
	// GET billing/:message_id
	router.get('billing/:message_id', (ctx) => {
		const msgId = Number(ctx.params.message_id);
		const row = ctx.db.prepare('SELECT data FROM statistics WHERE message_id = ?').get(msgId);
		ctx.send(200, row ? jsonParse(row.data) : null);
	});

	// POST billing
	router.post('billing', async (ctx) => {
		const body = await ctx.readBody();
		if (body.message_id == null) return ctx.send(400, { error: 'message_id required' });
		ctx.db.prepare('INSERT OR REPLACE INTO statistics (message_id, data) VALUES (?, ?)')
			.run(body.message_id, JSON.stringify(body));
		ctx.send(201, { success: true });
	});
}