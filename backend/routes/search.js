import {jsonParse, serializeConversation} from '../utils.js';

export function registerSearchRoutes(router) {
	router.get('search', async (ctx) => {
		const keyword = ctx.query.keyword;
		if (!keyword) return ctx.send(400, { error: 'keyword required' });

		let limit = parseInt(ctx.query.limit) || 50;
		if (limit > 100) limit = 100;

		// semantic keyword or null
		const mode = ctx.query.mode;

		const vectorDB = ctx.vectorDB;

		if (vectorDB && vectorDB.size === 0) {
			console.log("正在初始化语义索引...");
			const batchSize = 500;
			let lastId = 0;

			while (true) {
				// 使用 ID 游标分页比 OFFSET 更快
				const rows = ctx.db.prepare(
					'SELECT id, content, data FROM messages WHERE id > ? ORDER BY id LIMIT ?'
				).all(lastId, batchSize);

				if (rows.length === 0) break;

				for (const row of rows) {
					const body = jsonParse(row.data);
					const idStr = row.id.toString(36);

					// 索引内容
					if (row.content) await vectorDB.set('m#'+idStr, row.content);
					// 索引思考过程
					const thinking = body.think?.content;
					if (thinking) await vectorDB.set('M#'+idStr, thinking);

					lastId = row.id;
				}
				console.log(`已索引至 ID: ${lastId}`);
			}
			console.log("语义索引初始化完成。");
		}

		let vectorKeys = new Map;
		if (mode !== 'keyword' && vectorDB && keyword.length > 2) {
			console.time("语义搜索");
			// ids 结构为 [{id: "m#abc", score: 0.9}, ...]
			const matches = await vectorDB.query(keyword, limit, 0.5);
			matches.forEach(m => vectorKeys.set(parseInt(m.id.substring(2), 36), m.score));
			console.timeEnd("语义搜索");
		}

		const searchPattern = `%${keyword}%`;

		const placeholders = Array(vectorKeys.size).fill('?').join(',');
		console.time("查询数据库");
		const sql = `
            WITH MatchedSet AS (
                -- 找出所有命中的消息及其所属对话
                SELECT m.id AS msg_id, 
                       m.owner AS conv_id, 
                       m.data AS msg_data,
                       m.content AS msg_content,
                       m.time AS msg_time
                FROM messages m
                WHERE m.id IN (${placeholders})
                   OR m.content LIKE ?
            ),
            RankedMatches AS (
                -- 对命中的消息按对话分组，并给每一行编个号
                SELECT 
                    *, 
                    ROW_NUMBER() OVER (PARTITION BY conv_id ORDER BY msg_id) as rn
                FROM MatchedSet
            ),
            FilteredConvs AS (
                -- 找出符合条件的前 N 个对话 ID
                SELECT DISTINCT conv_id FROM RankedMatches LIMIT ?
            )
            -- 最终查询：取出这些对话及其实际命中的那几条消息
            SELECT 
                c.*, 
                rm.msg_id, 
                rm.msg_data,
                rm.msg_content,
                rm.msg_time
            FROM FilteredConvs fc
            JOIN conversations c ON c.id = fc.conv_id
            JOIN RankedMatches rm ON rm.conv_id = fc.conv_id
            WHERE rm.rn <= ?  -- 每个对话只取前 5 条命中的消息
            ORDER BY c.id DESC, rm.msg_id
        `;

		const rows = ctx.db.prepare(sql).all(
			...vectorKeys.keys(),
			searchPattern,
			limit,
			10 // 每个对话最多返回的消息数量
		);
		console.timeEnd(`查询数据库`);
		console.log(`完成，找到 ${rows.length} 条消息`);

		// 3. 内存聚合（将扁平的行结构转回 conversation -> messages 结构）
		const conversations = new Map();

		for (const row of rows) {
			if (!conversations.has(row.id)) {
				const conv = serializeConversation(row);
				conv.messages = [];
				conversations.set(row.id, conv);
			}

			const msg = jsonParse(row.msg_data, {
				id: row.msg_id,
				content: row.msg_content,
				time: row.msg_time
			});

			const score = vectorKeys.get(msg.id);
			if (score != null) msg.cossim = score;

			delete msg.tool_responses;
			delete msg.tool_calls;
			delete msg.reasoning_details;

			conversations.get(row.id).messages.push(msg);
		}

		ctx.send(200, Array.from(conversations.values()));
	});
}