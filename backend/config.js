/**
 * 语义搜索相关配置
 * 用于向量化处理、文本嵌入（Embedding）及相关 API 设置
 */
// 是否启用语义搜索功能
export const SEMANTIC_SEARCH_ENABLE = true;

// 向量化 API 的基础请求地址
export const SEMANTIC_SEARCH_API_BASE = 'http://localhost:5002/api/v1/embeddings';

// 向量化 API 的访问密钥（API Key）
export const SEMANTIC_SEARCH_API_KEY = "";

// 所使用的 Embedding 模型名称（如：qwen3-embedding-0.6b）
export const SEMANTIC_SEARCH_API_MODEL = "qwen3-embedding-0.6b";

// 向量维度大小（需根据模型实际输出维度设置，如 1024 或 768）
export const SEMANTIC_SEARCH_EMBEDDING_SIZE = 1024;

// 文本分块（Chunking）模式设置
export const SEMANTIC_SEARCH_CHUNK_MODE = {
	/**
	 * type 支持:
	 * 1. "head": 只取开头
	 * 2. "head-tail": 取头尾各一半
	 */
	type: "head-tail",
	// 最大截取字符长度
	length: 4096
};

/**
 * 数据同步与实时通讯配置 (WebSocket)
 */
// 是否开启 WebSocket 实时同步功能
export const WEBSOCKET_SYNC_ENABLE = true;

/**
 * 动态生成 WebSocket 同步地址
 * @param {AIChatBackend.RouteContext} ctx - 路由上下文对象，包含请求头和参数
 * @return {string} 返回完整的 WebSocket URL
 */
export const WEBSOCKET_SYNC_BASE = (ctx) => {
	const userId = ctx.params.userId;
	// 自动获取当前 Host 并拼接 userId
	// 如果使用反代和/或https，请修改此处
	return "ws://"+ctx.req.headers.host+"/aichat/v2/sync?user="+encodeURIComponent(userId);
};

/**
 * 数据库安全配置
 */
// 是否允许删除数据库（生产环境建议设为 false，防止误操作导致数据丢失）
export const ALLOW_DROP_DATABASE = false;

/**
 * 服务器发送事件 (SSE) 配置
 */
// SSE 连接恢复超时时间（毫秒），15分钟
// 用于在连接意外断开后，允许客户端在指定时间内恢复之前的会话
export const SSE_RESUME_TIMEOUT = 1000 * 60 * 15;

/**
 * SSE 后端代理转发配置
 *
 * 逻辑说明：
 * 1. 程序会获取请求头中的 authorization (如 "Bearer xxx") 作为键名在该对象中查找。
 * 2. 如果匹配成功，将使用对应的 url 和 authorization 替换原有请求。
 * 3. 如果未匹配成功，则回退到 'default' 配置。
 * 4. 如果 'default' 配置中未定义 authorization，则保留客户端原始传入的密钥（实现 BYOK 模式）。
 * 5. 如果没有 'default' 配置，返回 403
 */
export const SSE_PROXY_BACKEND = {
	"Bearer someKey": {
		url: '',
		authorization: 'Bearer xxx'
	},

	default: {
		url: '',
		authorization: 'Bearer xxx'
	}
};