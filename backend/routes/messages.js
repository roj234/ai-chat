import {deserializeRow} from '../utils.js';

export function registerMessageRoutes(router) {
	// 列出对话简单数据，每条可能就几十字节，没什么好分页的
	router.get('/conversations', (ctx) => {
		const rows = ctx.db.prepare('SELECT id, title, time FROM conversations ORDER BY time DESC').all();
		ctx.send(200, rows);
	});

	// 增加新对话
	router.post('/conversations', async (ctx) => {
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

	// 更新对话
	router.put('/conversations/:id', async (ctx) => {
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

	// 删除对话
	router.delete('/conversations/:id', (ctx) => {
		const id = Number(ctx.params.id);
		const deletedRows = ctx.db.prepare('DELETE FROM messages WHERE owner = ? RETURNING id').all(id);
		if (ctx.vectorDB) {
			deletedRows.forEach(({id}) => {
				ctx.vectorDB.delete('m#'+id.toString(36));
				ctx.vectorDB.delete('M#'+id.toString(36));
			});
		}
		ctx.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});

	// 读取对话完整元数据
	router.get('/conversations/:id', (ctx) => {
		const id = Number(ctx.params.id);
		const conv = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
		if (!conv) return ctx.send(404, { error: 'Not found' });
		ctx.send(200, deserializeRow(conv));
	});

	// 列出对话的消息
	router.get('/conversations/:id/messages', (ctx) => {
		const id = Number(ctx.params.id);
		const messages = ctx.db.prepare('SELECT id, content, time, data FROM messages WHERE owner = ? ORDER BY id').all(id);
		ctx.send(200, messages.map(row => {
			const msg = deserializeRow(row);

			const content = msg.content;
			if (Array.isArray(content)) {
				content[content.findIndex(item => item.type === 'row')] = {
					type: "text",
					text: row.content
				};
			}
			return msg;
		}));
	});

	// 创建或更新消息
	router.post('/messages', async (ctx) => {
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
			if (time == null) time = Date.now();

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

	// 删除消息
	router.delete('/messages/:id', (ctx) => {
		const id = Number(ctx.params.id);
		if (ctx.vectorDB) {
			ctx.vectorDB.delete('m#'+id.toString(36));
			ctx.vectorDB.delete('M#'+id.toString(36));
		}
		ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
		ctx.send(200, { success: true });
	});
}