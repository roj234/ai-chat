
export const SEMANTIC_SEARCH_ENABLE = true;
export const SEMANTIC_SEARCH_API_BASE = 'http://localhost:5002/api/v1/embeddings';
export const SEMANTIC_SEARCH_API_KEY = "";
export const SEMANTIC_SEARCH_API_MODEL = "qwen3-embedding-0.6b";
export const SEMANTIC_SEARCH_EMBEDDING_SIZE = 1024;
export const SEMANTIC_SEARCH_CHUNK_MODE = {
	// 目前只支持取开头部分
	type: "length",
	length: 4096
};

export const WEBSOCKET_SYNC_ENABLE = true;
/**
 *
 * @param ctx
 * @return {undefined|string}
 */
export const WEBSOCKET_SYNC_BASE = (ctx) => {
	const userId = ctx.param.userId;
	return "ws://"+ctx.req.headers.host+"/aichat/v2/sync?user="+encodeURIComponent(userId);
};

export const ALLOW_DROP_DATABASE = false;