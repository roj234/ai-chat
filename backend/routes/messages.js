import {jsonParse} from '../utils.js';

export function registerMessageRoutes(router) {
	// GET conversations/:id/messages
	router.get('conversations/:id/messages', (ctx) => {
		const ownerId = Number(ctx.params.id);
		const messages = ctx.db.prepare('SELECT id, data FROM messages WHERE owner = ?').all(ownerId);
		const parsed = messages.map(row => {
			const msg = jsonParse(row.data);
			msg.id = row.id;
			return msg;
		});
		parsed.sort((a, b) => {
			const b1 = a.role === "system";
			const b2 = b.role === "system";
			if (b1 !== b2) return b2 - b1;

			return a.time - b.time
		});
		ctx.send(200, parsed);
	});

	// POST messages (create or update)
	router.post('messages', async (ctx) => {
		const body = await ctx.readBody();
		let id = body.id;
		const owner = body.owner;

		if (owner == null) return ctx.send(400, { error: 'missing owner' });

		delete body.owner;
		delete body.id;
		const serializedData = JSON.stringify(body);

		if (id && !isNaN(id)) {
			ctx.db.prepare('UPDATE messages SET data = ?, owner = ? WHERE id = ?').run(serializedData, owner, id);
		} else {
			const info = ctx.db.prepare('INSERT INTO messages (owner, data) VALUES (?, ?)').run(owner, serializedData);
			id = Number(info.lastInsertRowid);
		}
		if (ctx.vectorDB) {
			ctx.vectorDB.set('m#'+id.toString(36), body.content);
			if (body.think?.content)
				ctx.vectorDB.set('M#'+id.toString(36), body.think.content);
		}
		ctx.send(200, { success: true, id });
	});

	// DELETE messages/:id
	router.delete('messages/:id', (ctx) => {
		const id = Number(ctx.params.id);
		if (ctx.vectorDB) {
			ctx.vectorDB.delete('m#'+id.toString(36));
			ctx.vectorDB.delete('M#'+id.toString(36));
		}
		ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});
}