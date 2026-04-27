import {compressGeneric, decompressGeneric, deserializeRow} from "../utils/compression.js";

export function registerKVRoutes(router) {
	// GET kv?key=...
	router.get('/kv', (ctx) => {
		const {key} = ctx.query;
		if (!key) return ctx.send(400, { error: 'key required' });

		const row = ctx.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
		ctx.send(200, row ? decompressGeneric(row.value) : null);
	});

	// PUT kv
	router.put('/kv', async (ctx) => {
		const { key, value } = await ctx.readBody();
		if (!key) return ctx.send(400, { error: 'key required' });

		ctx.db.prepare('REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, compressGeneric(value));
		ctx.send(200, { success: true });
	});

	// DELETE kv?key=...
	router.delete('/kv', (ctx) => {
		const {key} = ctx.query;
		if (!key) return ctx.send(400, { error: 'key required' });

		ctx.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
		ctx.send(200, { success: true });
	});

	// GET kvs/keys?type=...
	router.get('/kvs/keys', (ctx) => {
		const {type} = ctx.query;
		if (!type) return ctx.send(400, { error: 'type required' });

		const rows = ctx.db.prepare('SELECT name FROM kvs WHERE type = ?').all(type);
		ctx.send(200, rows);
	});

	// GET kvs?type=...
	router.get('/kvs/values', (ctx) => {
		const {type} = ctx.query;
		if (!type) return ctx.send(400, { error: 'type required' });

		// * 是给备份用的
		const rows = type === '*' ? ctx.db.prepare('SELECT * from kvs').all() : ctx.db.prepare('SELECT * FROM kvs WHERE type = ?').all(type);
		ctx.send(200, rows.map(deserializeRow));
	});

	// GET kvs/by-name?type=...&name=...
	router.get('/kvs', (ctx) => {
		const { type, name } = ctx.query;
		if (!type || !name) return ctx.send(400, { error: 'type and name required' });

		const row = ctx.db.prepare('SELECT * FROM kvs WHERE type = ? AND name = ?').get(type, name);
		if (!row) return ctx.send(404, { error: 'Not found' });

		ctx.send(200, deserializeRow(row));
	});

	// POST kvs
	router.post('/kvs', async (ctx) => {
		const body = await ctx.readBody();
		const { type, name, ...rest } = body;
		if (!type || !name) return ctx.send(400, { error: 'type and name required' });
		const info = ctx.db.prepare('REPLACE INTO kvs (type, name, data) VALUES (?, ?, ?)').run(type, name, compressGeneric(rest));
		ctx.send(201, { __id: Number(info.lastInsertRowid), type, name, ...rest });
	});

	// DELETE kvs/:id
	router.delete('/kvs', (ctx) => {
		const { type, name } = ctx.query;
		if (!type || !name) return ctx.send(400, { error: 'type and name required' });

		ctx.db.prepare('DELETE FROM kvs WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});
}