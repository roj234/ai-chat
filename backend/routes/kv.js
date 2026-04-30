import {jsonParse} from '../utils.js';

export function registerKvRoutes(router) {
	// GET kv?key=...
	router.get('kv', (ctx) => {
		const key = ctx.query.key;
		if (!key) return ctx.send(400, { error: 'key required' });
		const row = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
		ctx.send(200, row ? jsonParse(row.value) : null);
	});

	// PUT kv
	router.put('kv', async (ctx) => {
		const body = await ctx.readBody();
		const { key, value } = body;
		if (!key) return ctx.send(400, { error: 'key required' });
		ctx.db.prepare('REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
		ctx.send(200, { success: true });
	});

	// DELETE kv?key=...
	router.delete('kv', (ctx) => {
		const key = ctx.query.key;
		if (!key) return ctx.send(400, { error: 'key required' });
		ctx.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
		ctx.send(200, { success: true });
	});
}