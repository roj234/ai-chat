/**
 * AIChat 配置文件模版
 *
 * 注意：修改此文件后需重启服务以生效。
 * 建议在生产环境中通过环境变量或专门的配置文件管理敏感信息。
 */

// ==========================================
// 1. 语义搜索与向量化 (Semantic Search)
// ==========================================

/** 是否启用语义搜索功能（需要向量数据库支持） */
export const SEMANTIC_SEARCH_ENABLE = true;

/** 向量化 API 地址 (如 OpenAI, llama-server 或 我的参考实现) */
export const SEMANTIC_SEARCH_API_BASE = 'http://localhost:5002/api/v1/embeddings';

/** 向量化 API 访问密钥 */
export const SEMANTIC_SEARCH_API_KEY = "";

/** 使用的 Embedding 模型 (需与维度 SEMANTIC_SEARCH_EMBEDDING_SIZE 匹配) */
export const SEMANTIC_SEARCH_API_MODEL = "qwen3-embedding-0.6b";

/** 向量维度：OpenAI 一般为 1536，本地模型常用 768 或 1024 */
export const SEMANTIC_SEARCH_EMBEDDING_SIZE = 1024;

/**
 * 文本分块 (Chunking) 策略
 * 用于处理长文本超过嵌入模型上下文的情况
 */
export const SEMANTIC_SEARCH_CHUNK_MODE = {
	/**
	 * type 模式:
	 * - "head": 仅保留开头（适合摘要类）
	 * - "head-tail": 取头尾各一半（适合长文语义保留）
	 */
	type: "head-tail",
	/** 分块截取后的最大字符长度 */
	length: 4096
};

// ==========================================
// 2. 实时同步与用户管理
// ==========================================

/**
 * 服务器API直连地址 (用于输入用户名)
 * @example https://nas.lan/aichat/api/
 */
export const SERVER_BASE_ADDR = ``;

/** 是否开启 WebSocket 状态同步 */
export const WEBSOCKET_SYNC_ENABLE = true;

/**
 * 动态生成 WebSocket 连接地址
 * @param {AiChatBackend.RouteContext} ctx - 路由上下文
 * @returns {string} 完整的 WebSocket WS/WSS URL
 */
export const WEBSOCKET_SYNC_BASE = (ctx) => {
	const userId = ctx.params.userId;
	// 默认获取当前请求 Host。
	// 注意：若处于反向代理后或使用了 HTTPS，需手动修改此处
	return `ws://${ctx.req.headers.host}/api/sync?user=${encodeURIComponent(userId)}`;
};

/** 是否开启用户注册限制 */
export const RESTRICT_USER_CREATION = false;

/** 白名单用户列表：仅当 RESTRICT_USER_CREATION 为 true 时生效 */
export const ALLOW_USER_NAMES = new Set(['admin', 'user']);

// ==========================================
// 3. 安全与数据库设置
// ==========================================

/**
 * 数据库安全开关
 * 警告：设为 true 将允许通过 API 执行 DROP TABLE 等危险操作
 */
export const ALLOW_DROP_DATABASE = false;

/**
 * 启动/停止时执行的额外 SQLite 语句
 * 默认开启 WAL 模式以提升并发写入性能
 */
export const STARTUP_SQL = `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
`;
export const SHUTDOWN_SQL = ``;

/**
 * 启用文件传输助手
 */
export const ENABLE_FILE_TRANSFER = true;

// ==========================================
// 4. SSE 后端代理与转发 (SSE Proxy)
// ==========================================

/**
 * SSE 后端代理路由表
 *
 * 匹配逻辑：
 * 1. 匹配 Header 中的 Authorization (Bearer 后面的 Key)。
 * 2. 若匹配成功，则转发至对应的 url 并覆盖 authorization。
 * 3. 若未匹配，则尝试使用 'default' 配置。
 * 4. 若 'default' 未定义 authorization，则执行 BYOK (Bring Your Own Key) 模式。
 * 5. 无匹配项且无 default 时返回 403。
 */
export const SSE_PROXY_BACKEND = {
	"some-internal-key": {
		url: 'https://api.openai.com/v1/chat/completions',
		authorization: 'sk-xxxxxx',
		log: true // 是否记录该通道的日志 (需开启 SSE_PROXY_TRACE)
	},

	default: {
		url: '',
		authorization: 'xxx'
	}
};

/**
 * 可以async
 * @param {string} url
 * @param {string} apiKey
 * @param {AiChatBackend.RouteContext} ctx
 * @return {void | Object | function(OpenAI.ChatCompletionRequest): Object | void}
 */
export const SSE_PROXY_MODERATION = (url, apiKey, ctx) => {
	if (apiKey === 'some-key') return {error: "This key is forbidden"};

	// 可能为 null
	const {userId} = ctx.params;
	if (userId === 'admin') return;

	/**
	 *
	 * @param {string} text
	 * @return {{error: string}}
	 */
	const moderation = (text) => {
		if (text.includes("fuck")) {
			return {error: "This message considered high risk"};
		}
	}

	return (body) => {
		for (const {content} of body.messages) {
			if (Array.isArray(content)) {
				for (const {type, text} of content) {
					if (type === "text") {
						const result = moderation(text);
						if (result) return result;
					}
				}
			} else {
				return moderation(content);
			}
		}
	};
}

/** 是否开启黑箱调试：记录所有请求响应到 data/logs 目录 */
export const SSE_PROXY_TRACE = false;

/** 会话恢复超时时间 (毫秒)：默认 15 分钟 */
export const SSE_RESUME_TIMEOUT = 1000 * 60 * 15;

// ==========================================
// 5. 计费与价格映射 (Billing)
// ==========================================

/**
 * 日志钩子，可以在这里做一些计费和别名相关的操作，这个函数只影响日志记录
 * - 代码在入库时调用，改变代码不会影响数据库中的结果
 * @param {AiChat.BillingLog} log
 * @return {string}
 */
export const LOG_HOOK = (log) => {
	// 去除 OpenRouter 的模型名称前缀（当然也可以反过来加上，这只是 replace 的两个参数）
	log.model = log.model.replace(/^(anthropic|google|openrouter|openai|deepseek)\//, "");

	if (log.cost == null && log.model === "deepseek-v4-pro") {
		const { input_tokens = 0, cached_tokens = 0, cache_write_tokens = 0, output_tokens = 0, provider } = log;

		const CACHE_READ_PRICE = 0.025; // 每百万 Token 价格
		const INPUT_PRICE      = 3;
		const OUTPUT_PRICE     = 6;

		log.currency = "CNY";
		log.cost = (INPUT_PRICE * input_tokens + CACHE_READ_PRICE * cached_tokens + OUTPUT_PRICE * output_tokens) / 1000000;
		// 覆盖前端显示的渠道名称
		// log.provider = "DeepSeek";
	}
}

// ==========================================
// 6. 数据压缩与序列化 (Optimization)
//  - 修改这些选项不会影响之前的数据
// ==========================================

/** 是否使用 Msgpack 替代 JSON 序列化扩展字段（体积更小，速度更快） */
export const DB_USE_MSGPACK_SCHEMA = true;

/** 触发压缩的阈值（字节）：超过此大小的数据库字段将进行 brotli 压缩 */
export const DB_COMPRESS_MIN_SIZE = 1024;

/**
 * 数据库的 Brotli 压缩级别 (0-11)
 */
export const DB_COMPRESS_LEVEL = 7;

/** 是否使用 Msgpack 替代 JSON 序列化响应（体积更小，速度更快） */
export const RESPONSE_USE_MSGPACK_SCHEMA = true;

/**
 * 响应的 Brotli 压缩级别 (0-11)
 */
export const RESPONSE_COMPRESS_LEVEL = 6;

