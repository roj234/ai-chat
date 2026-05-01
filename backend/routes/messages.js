import {jsonParse} from '../utils.js';

export function registerMessageRoutes(router) {
	// GET conversations/:id/messages
	router.get('conversations/:id/messages', (ctx) => {
		const ownerId = Number(ctx.params.id);
		const messages = ctx.db.prepare('SELECT id, content, time, data FROM messages WHERE owner = ? ORDER BY id').all(ownerId);
		const parsed = messages.map(row => {
			const str = row.data;
			delete row.data;

			const msg = jsonParse(str, row);

			const content = msg.content;
			if (Array.isArray(content)) {
				content[content.findIndex(item => item.type === 'row')] = {
					type: "text",
					text: row.content
				};
			}
			return msg;
		});
		// 仅兼容性？实际上应该永远用不到
		parsed.sort((a, b) => {
			const b1 = a.role === "system";
			const b2 = b.role === "system";
			if (b1 !== b2) return b2 - b1;

			return a.time - b.time;
		});
		ctx.send(200, parsed);
	});

	// POST messages (create or update)
	router.post('messages', async (ctx) => {
		const body = await ctx.readBody();

		let {id, owner, content, time = null} = body;
		if (owner == null) return ctx.send(400, { error: 'missing conversation id' });

		delete body.id;
		delete body.owner;
		delete body.time;

		if (Array.isArray(content)) {
			const strContent = content.findIndex(item => item.type === "text");
			if (strContent < 0) {
				content = null;
			} else {
				content = body.content[strContent].text;
			}
			body.content[strContent] = { type: 'row' };
		} else {
			delete body.content;
		}

		const serializedData = JSON.stringify(body);

		if (id && !isNaN(id)) {
			ctx.db.prepare('UPDATE messages SET data = ?, content = ?, time = ? WHERE id = ?').run(serializedData, content, time, id);
		} else {
			const conversation = ctx.db.prepare(`SELECT time from conversations WHERE id = ?`).get(owner);
			if (conversation == null) return ctx.send(400, { error: 'unknown conversation id' });
			//if (time == null) time = conversation.time;

			const info = ctx.db.prepare('INSERT INTO messages (owner, data, content, time) VALUES (?, ?, ?, ?)').run(owner, serializedData, content, time);
			id = Number(info.lastInsertRowid);
		}

		if ((body.role === "user" || body.role === "assistant") && ctx.vectorDB) {
			if (content)
				ctx.vectorDB.set('m#'+id.toString(36), content);
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