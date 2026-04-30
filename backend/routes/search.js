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

		// --- 核心逻辑：如果向量库为空，则后台填充数据 ---
		if (vectorDB && vectorDB.size === 0) {
			console.log("正在初始化向量数据库...");
			const batchSize = 500;
			let lastId = 0;

			while (true) {
				// 使用 ID 游标分页比 OFFSET 更快
				const rows = ctx.db.prepare(
					'SELECT id, data FROM messages WHERE id > ? ORDER BY id LIMIT ?'
				).all(lastId, batchSize);

				if (rows.length === 0) break;

				for (const row of rows) {
					const body = jsonParse(row.data);
					const idStr = row.id.toString(36);

					// 索引内容
					if (body.content) await vectorDB.set('m#' + idStr, body.content);
					// 索引思考过程
					const thinking = body.think?.content;
					if (thinking) await vectorDB.set('M#' + idStr, thinking);

					lastId = row.id;
				}
				console.log(`已索引至 ID: ${lastId}`);
			}
			console.log("VectorDB 索引初始化完成。");
		}
		// ----------------------------------------------

		let vectorResults = [];
		if (mode !== 'keyword' && vectorDB && keyword.length > 2) {
			let threshold = 0.5;
			// ids 结构为 [{id: "m#abc", score: 0.9}, ...]
			const matches = await vectorDB.query(keyword, limit);
			for (let i = 0; i < matches.length; i++) {
				if (matches[i].score < threshold) {
					matches.length = i;
					break;
				}
			}
			vectorResults = matches.map(m => parseInt(m.id.substring(2), 36));
		}

		const searchPattern = `%${keyword}%`;

		const placeholders = Array(vectorResults.length).fill('?').join(',');
		const sql = `
            WITH MatchedSet AS (
                -- 找出所有命中的消息及其所属对话
                SELECT m.id AS msg_id, m.owner AS conv_id, m.data AS msg_data
                FROM messages m
                WHERE m.id IN (${placeholders})
                   OR json_extract(m.data, '$.content') LIKE ?
                   OR json_extract(m.data, '$.think.content') LIKE ?
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
                rm.msg_data
            FROM FilteredConvs fc
            JOIN conversations c ON c.id = fc.conv_id
            JOIN RankedMatches rm ON rm.conv_id = fc.conv_id
            WHERE rm.rn <= ?  -- 每个对话只取前 5 条命中的消息
            ORDER BY c.id DESC, rm.msg_id
        `;

		const rows = ctx.db.prepare(sql).all(
			...vectorResults,
			searchPattern,
			searchPattern,
			limit,
			10 // 返回的消息数量
		);

		// 3. 内存聚合（将扁平的行结构转回 conversation -> messages 结构）
		const conversations = new Map();

		for (const row of rows) {
			if (!conversations.has(row.id)) {
				const conv = serializeConversation(row);
				conv.messages = [];
				conversations.set(row.id, conv);
			}

			const msg = jsonParse(row.msg_data);
			msg.id = row.msg_id;

			delete msg.tool_responses;
			delete msg.tool_calls;

			conversations.get(row.id).messages.push(msg);
		}

		ctx.send(200, Array.from(conversations.values()));
	});
}