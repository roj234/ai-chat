import {
	compressConversation,
	compressMessage,
	decompressConversation,
	decompressMessage,
	deserializeRow
} from "../utils/compression.js";
import {patch} from "unconscious/common/deepEqual.js";

/**
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 */
export function registerMessageRoutes(batcher) {
	// 列出对话
	batcher["conversations"] = (_, {db}) => {
		return db.prepare('SELECT id, title, time FROM conversations ORDER BY time DESC').all();
	};

	// 增加或修改对话
	batcher["conversation/upsert"] = async ({ id, ...diff }, ctx) => {
		const setConversationId = ctx.setVariable("conversationId");

		if (Number.isFinite(id)) {
			const row = ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
			if (!row) return { error: 'no such id' };

			const conv = deserializeRow(row, decompressConversation);
			patch(conv, diff);
			diff = conv;
		}

		const { title = '', time = Date.now(), ...data } = diff;

		if (Number.isFinite(id)) {
			ctx.db.prepare('UPDATE conversations SET title = ?, time = ?, data = ? WHERE id = ?')
				.run(title, time, await compressConversation(data), id);
		} else {
			if (id !== undefined) return { error: "illegal id" };

			const info = ctx.db.prepare('INSERT INTO conversations (title, time, data) VALUES (?, ?, ?)')
				.run(title, time, await compressConversation(data));

			id = Number(info.lastInsertRowid);
		}
		setConversationId(id);
		return id;
	};

	// 删除对话
	batcher["conversation/delete"] = (id, {db, vectorDB}) => {
		if (!Number.isFinite(id)) return { error: 'illegal id' };

		const deletedRows = db.prepare('DELETE FROM messages WHERE owner = ? RETURNING id').all(id);
		if (vectorDB) {
			deletedRows.forEach(({id}) => {
				vectorDB.delete('m#'+id.toString(36));
				vectorDB.delete('M#'+id.toString(36));
			});
		}
		const info = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
		return info.changes > 0;
	};

	// 读取对话元数据
	batcher["conversation"] = (id, ctx) => {
		if (!Number.isFinite(id)) return { error: 'illegal id' };

		const {db} = ctx;
		const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
		return conv ? deserializeRow(conv, decompressConversation) : { error: 'not found' };
	}

	const deserializeMessage = row => {
		const msg = deserializeRow(row, decompressMessage);
		const content = msg.content;
		if (Array.isArray(content)) {
			const index = content.findIndex(item => item.type === 'row');
			if (index >= 0) content[index] = { type: "text", text: row.content };
		}
		return msg;
	};

	// 列出对话消息
	batcher["messages"] = (id, ctx) => {
		if (!Number.isFinite(id)) return { error: 'illegal id' };

		/** @type {AiChat.Message[]} */
		const messages = ctx.db.prepare('SELECT id, content, time, data FROM messages WHERE owner = ? ORDER BY id').all(id);

		return messages.map(deserializeMessage).sort((a, b) => {
			const b1 = a.role === "system";
			const b2 = b.role === "system";
			if (b1 !== b2) return b2 - b1;
			return 0;
		});
	}

	// 创建或更新消息
	batcher["message/upsert"] = async ({id, owner, ...diff }, ctx) => {
		owner = owner ?? await ctx.getVariable("conversationId");
		if (!Number.isFinite(owner)) return { error: 'missing owner' };

		let oldThink, oldContent;
		if (Number.isFinite(id)) {
			const row = ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
			if (!row) return { error: 'no such id' };

			const msg = deserializeMessage(row);
			oldThink = msg.think?.constructor;
			oldContent = row.content;
			patch(msg, diff);
			diff = msg;
		}

		let { content, time = null, ...data } = diff;

		if (typeof content !== "string") {
			data.content = content;
			if (Array.isArray(content)) {
				const strContent = content.findIndex(item => typeof item.text === "string");
				if (strContent < 0) {
					content = '';
				} else {
					content = data.content[strContent].text;
					data.content[strContent] = { type: 'row' };
				}
			} else {
				content = '';
			}
		}

		const {db, vectorDB} = ctx;

		const setMessageId = ctx.setVariable("messageId");
		const serializedData = await compressMessage(data);

		if (Number.isFinite(id)) {
			const result = db.prepare('UPDATE messages SET data = ?, content = ?, time = ? WHERE id = ? AND owner = ?').run(serializedData, content, time, id, owner);
			if (!result.changes) return { error: 'no such id' };
		} else {
			if (id !== undefined) return { error: 'illegal id' };

			const conversation = db.prepare(`SELECT id from conversations WHERE id = ?`).get(owner);
			if (conversation == null) return { error: 'no such owner' };
			//if (time == null) time = Date.now();

			const info = db.prepare('INSERT INTO messages (owner, data, content, time) VALUES (?, ?, ?, ?)').run(owner, serializedData, content, time);
			id = info.lastInsertRowid;
		}

		if (vectorDB) {
			const isSearchable = data.role === "user" || data.role === "assistant";

			if (isSearchable && content) {
				if (content !== oldContent)
					vectorDB.set('m#'+id.toString(36), content);
			}
			else vectorDB.delete('m#'+id.toString(36));

			const thinkContent = data.think?.content;
			if (isSearchable && thinkContent) {
				if (thinkContent !== oldThink)
					vectorDB.set('M#'+id.toString(36), thinkContent);
			}
			// maybe if(oldThink) here
			else vectorDB.delete('M#'+id.toString(36));
		}

		setMessageId(id);
		return id;
	};

	// 删除消息
	batcher["message/delete"] = (id, ctx) => {
		if (!Number.isFinite(id)) return { error: 'illegal id' };

		const {db, vectorDB} = ctx;
		const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
		if (!result.changes) return false;

		if (vectorDB) {
			vectorDB.delete('m#'+id.toString(36));
			vectorDB.delete('M#'+id.toString(36));
		}
		return true;
	};
}