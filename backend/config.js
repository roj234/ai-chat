
export const SEMANTIC_SEARCH_ENABLE = true;
export const SEMANTIC_SEARCH_API_BASE = 'http://localhost:5002/api/v1/embeddings';
export const SEMANTIC_SEARCH_API_KEY = "";
export const SEMANTIC_SEARCH_API_MODEL = "qwen3-embedding-0.6b";
// TODO 转为BF16存储
export const SEMANTIC_SEARCH_EMBEDDING_SIZE = 1024;
// 目前只支持取开头部分
export const SEMANTIC_SEARCH_CHUNK_MODE = {
	type: "length",
	length: 4096
};

export const WEBSOCKET_SYNC_ENABLE = true;