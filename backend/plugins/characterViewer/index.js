const {decompressGeneric} = globalThis.AiChatAPI;

export default function (router) {
	router.push('v2/:userId/cards');
	registerCardStorageRoutes(router);
	router.pop();
}

/**
 * 现在角色卡以 type = 'st|char' 存储在 kvs 表中。
 * 每个卡片的 data（压缩 JSON）包含所有字段，包括
 * image: { hash: string } 用于外部图片引用。
 * 图像二进制数据不再存储，图像接口已移除。
 */
function registerCardStorageRoutes(router) {
	const CARD_TYPE = 'st|char';

	function getAllCards(db) {
		const rows = db.prepare('SELECT name, data FROM kvs WHERE type = ?').all(CARD_TYPE);
		return rows.map(item => {
			/**
			 * @type {AiChat.DnD.MyCharacter}
			 */
			const chr = decompressGeneric(item.data);
			return {
				name: item.name,
				image_hash: chr.image?.hash,
				tags: chr.tags,
				description: chr.description,
				time: chr.time,
				creator: chr.creator,
				creatorNotes: chr.creatorNotes,
			};
		});
	}

	// GET /cards — 列表（支持分页与搜索）
	router.get('/', ctx => {
		const { db } = ctx;
		const { search, page = 1, limit = 20 } = ctx.query;
		const pageNum = Math.max(1, parseInt(page) || 1);
		const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 20));

		let cards = getAllCards(db);

		if (search) {
			const q = String(search).toLowerCase();
			cards = cards.filter(c => {
				return Object.values(c).some(f => f != null && String(f).toLowerCase().includes(q));
			});
		}

		const total = cards.length;
		const start = (pageNum - 1) * pageSize;
		const data = cards.slice(start, start + pageSize);

		ctx.send(200, { total, data });
	});
}