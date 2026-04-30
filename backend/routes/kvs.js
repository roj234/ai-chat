import {jsonParse} from '../utils.js';

export function registerKvsRoutes(router) {
	// GET kvs?type=...
	router.get('kvs', (ctx) => {
		const type = ctx.query.type;
		if (!type) return ctx.send(400, { error: 'type required' });
		const rows = ctx.db.prepare('SELECT * FROM kvs WHERE type = ? ORDER BY id').all(type);
		const mapped = rows.map(r => {
			const parsed = jsonParse(r.data);
			return { id: r.id, type: r.type, name: r.name, ...parsed };
		});
		ctx.send(200, mapped);
	});

	// GET kvs/keys?type=...
	router.get('kvs/keys', (ctx) => {
		const type = ctx.query.type;
		if (!type) return ctx.send(400, { error: 'type required' });
		const rows = ctx.db.prepare('SELECT id, name FROM kvs WHERE type = ? ORDER BY id').all(type);
		ctx.send(200, rows);
	});

	// GET kvs/by-name?type=...&name=...
	router.get('kvs/by-name', (ctx) => {
		const { type, name } = ctx.query;
		if (!type || !name) return ctx.send(400, { error: 'type and name required' });
		const row = ctx.db.prepare('SELECT * FROM kvs WHERE type = ? AND name = ?').get(type, name);
		if (!row) return ctx.send(404, { error: 'Not found' });
		const data = jsonParse(row.data);
		ctx.send(200, { id: row.id, type: row.type, name: row.name, ...data });
	});

	// POST kvs
	router.post('kvs', async (ctx) => {
		const body = await ctx.readBody();
		const { type, name, ...rest } = body;
		if (!type || !name) return ctx.send(400, { error: 'type and name required' });
		const data = JSON.stringify(rest);
		const info = ctx.db.prepare('INSERT INTO kvs (type, name, data) VALUES (?, ?, ?)').run(type, name, data);
		ctx.send(201, { id: Number(info.lastInsertRowid), type, name, ...rest });
	});

	// GET kvs/:id
	router.get('kvs/:id', (ctx) => {
		const id = Number(ctx.params.id);
		const row = ctx.db.prepare('SELECT * FROM kvs WHERE id = ?').get(id);
		if (!row) return ctx.send(404, { error: 'Not found' });
		const data = jsonParse(row.data);
		ctx.send(200, { id: row.id, type: row.type, name: row.name, ...data });
	});

	// PUT kvs/:id
	router.put('kvs/:id', async (ctx) => {
		const id = Number(ctx.params.id);
		const body = await ctx.readBody();
		const { type, name, ...rest } = body;
		const setParts = [];
		const values = [];
		if (type) { setParts.push('type = ?'); values.push(type); }
		if (name) { setParts.push('name = ?'); values.push(name); }
		if (Object.keys(rest).length > 0) {
			setParts.push('data = ?');
			values.push(JSON.stringify(rest));
		}
		if (setParts.length > 0) {
			ctx.db.prepare(`UPDATE kvs SET ${setParts.join(', ')} WHERE id = ?`).run(...values, id);
		}
		ctx.send(200, { success: true });
	});

	// DELETE kvs/:id
	router.delete('kvs/:id', (ctx) => {
		const id = Number(ctx.params.id);
		ctx.db.prepare('DELETE FROM kvs WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});
}