import {serializeConversation} from '../utils.js';

export function registerConversationRoutes(router) {
	// GET conversations
	router.get('conversations', (ctx) => {
		const rows = ctx.db.prepare('SELECT * FROM conversations ORDER BY time DESC').all();
		ctx.send(200, rows.map(serializeConversation));
	});

	// POST conversations
	router.post('conversations', async (ctx) => {
		const body = await ctx.readBody();
		body.time = body.time || Date.now();
		delete body.id;

		const data = { ...body };
		delete data.title;
		delete data.time;

		const stmt = ctx.db.prepare('INSERT INTO conversations (title, time, data) VALUES (?, ?, ?)');
		const info = stmt.run(body.title || '', body.time, JSON.stringify(data));
		ctx.send(201, { success: true, id: Number(info.lastInsertRowid) });
	});

	// GET conversations/:id
	router.get('conversations/:id', (ctx) => {
		const id = Number(ctx.params.id);
		const conv = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
		if (!conv) return ctx.send(404, { error: 'Not found' });
		ctx.send(200, serializeConversation(conv));
	});

	// PUT conversations/:id
	router.put('conversations/:id', async (ctx) => {
		const id = Number(ctx.params.id);
		const body = await ctx.readBody();

		const data = { ...body };
		delete data.id;
		delete data.title;
		delete data.time;

		ctx.db.prepare('UPDATE conversations SET title = ?, time = ?, data = ? WHERE id = ?')
			.run(body.title, body.time, JSON.stringify(data), id);

		ctx.send(200, { success: true });
	});

	// DELETE conversations/:id
	router.delete('conversations/:id', (ctx) => {
		const id = Number(ctx.params.id);
		ctx.db.prepare('DELETE FROM messages WHERE owner = ?').run(id);
		ctx.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});
}