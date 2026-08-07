import {sseFetch} from "./openai-api-utils.js";

export class MCPClient {
	statusListener;
	options;

	/** @type {string} */
	#baseUrl;
	/** @type {string|null} 消息端点 URL */
	#messageUrl;
	/** @type {Error} */
	#error;

	#connectPromise;

	/** @type {object|null} 服务器信息 */
	#serverInfo = null;

	/** @type {number} JSON-RPC 请求 ID 自增 */
	#reqId = 0;
	/** @type {Map<number, {resolve,reject}>} */
	#pending = new Map();

	/** @type {'sse'|'http'|null} 当前传输模式 */
	#transportMode = null;

	/** @type {Record<string, string>|null} Streamable HTTP 的 session ID */
	#headers = null;

	/** @type {AbortController|null} SSE 流的 closer */
	#closer = null;

	/**
	 * @param {string} baseUrl
	 * @param {Object} options
	 */
	constructor(baseUrl, options = {}) {
		this.#baseUrl = baseUrl.replace(/\/$/, '');
		this.options = options;
	}

	get isOpen() { return this.#serverInfo != null; }
	get serverInfo() { return this.#serverInfo; }
	get lastError() { return this.#error; }

	/**
	 * 连接服务器。先尝试 SSE (GET)，失败则 fallback 到 Streamable HTTP (POST)
	 * @returns {Promise<object>}
	 */
	async connect() {
		let connectPromise = this.#connectPromise;
		if (connectPromise) return connectPromise;

		let _resolve, _reject;

		connectPromise = this.#connectPromise = new Promise((resolve, reject) => {
			_resolve = resolve;
			_reject = reject;
		}).then(() => this.jsonRPC('initialize', {
			protocolVersion: '2024-11-05',
			capabilities:    {},
			clientInfo:      {
				name:    APP_NAME,
				version: APP_VERSION,
			},
		}));
		connectPromise.then((handshake) => {
			this.#serverInfo = handshake;
			this.statusListener?.(true);
			return this.jsonRPC("notifications/initialized", undefined, true);
		});

		const closer = this.#closer = new AbortController;

		const timeout = setTimeout(() => {
			this.#error = new Error('连接超时');
			closer.abort();
		}, 10000);

		sseFetch(this.#baseUrl, {
			method: 'GET',
			key: this.options.key,
			signal: closer.signal
		}, (msg, event) => {
			if (event === 'endpoint') {
				clearTimeout(timeout);
				this.#messageUrl = new URL(msg, this.#baseUrl).href;
				this.#transportMode = 'sse';
				_resolve();
				return;
			}

			try {
				// 通知，先忽略吧
				if (null == msg.id) return;
				const [ resolve, reject ] = this.#pending.get(msg.id);
				this.#pending.delete(msg.id);

				if (msg.error) {
					const errMsg = msg.error.message || 'Unknown error';
					reject(new Error(`JSON-RPC ${msg.error.code}: ${errMsg}`));
				} else {
					resolve(msg.result);
				}
			} catch (e) {
				this.disconnect(e);
			}
		}).catch(err => {
			if (err.status >= 400 && !this.#messageUrl) {
				clearTimeout(timeout);

				// try streamable HTTP
				this.#transportMode = 'http';
				this.#messageUrl = this.#baseUrl;
				_resolve();
			}
		}).finally(() => {
			if (this.#transportMode === 'http') return;

			const reason = this.#error || new Error('SSE 流断开');
			_reject(reason);

			for (const [ , reject ] of this.#pending.values()) reject(reason);
			this.#pending.clear();
			this.disconnect(reason);
		});

		return connectPromise;
	}

	async disconnect(reason) {
		if (this.#headers) {
			await fetch(this.#messageUrl, {
				method: "DELETE",
				headers: {
					...this.#headers,
					'Authorization': `Bearer ${this.options.key}`
				},
			});
		}

		this.#error = reason;
		this.#messageUrl = null;
		this.#serverInfo = null;
		this.#transportMode = null;
		this.#headers = null;
		this.#connectPromise = null;
		this.#closer?.abort(reason);
		this.#closer = null;
		this.#reqId = 0;
		this.statusListener?.(false);
	}

	/**
	 * 列出工具
	 * @returns {Promise<{tools: Array}>}
	 */
	listTools() {return this.jsonRPC('tools/list', {});}

	/**
	 * 调用工具
	 * @param {string} name  - 工具名称
	 * @param {object} [args={}] - 工具参数
	 * @returns {Promise<{content: Array, isError?: boolean}>}
	 */
	callTool(name, args = {}) {return this.jsonRPC('tools/call', { name, arguments: args });}

	/**
	 * 列出资源
	 * @returns {Promise<{resources: Array}>}
	 */
	listResources() {return this.jsonRPC('resources/list');}

	/**
	 * 读取资源
	 * @param {string} uri - 资源 URI
	 * @returns {Promise<{contents: Array}>}
	 */
	readResource(uri) {return this.jsonRPC('resources/read', { uri });}

	/**
	 * 列出 Prompt 模板
	 * @returns {Promise<{prompts: Array}>}
	 */
	listPrompts() {return this.jsonRPC('prompts/list');}

	/**
	 * 获取填充后的 Prompt
	 * @param {string} name      - Prompt 名称
	 * @param {object} [args={}] - 参数
	 * @returns {Promise<{messages: Array}>}
	 */
	getPrompt(name, args = {}) {return this.jsonRPC('prompts/get', { name, arguments: args });}

	/**
	 * 参数自动补全
	 * @param {{type:'ref/resource'|'ref/prompt', uri?:string, name?:string}} ref
	 * @param {{name:string, value:string}} argument
	 * @returns {Promise<{completion: {values: string[], total: number, hasMore: boolean}}>}
	 */
	complete(ref, argument) {return this.jsonRPC('completion/complete', { ref, argument });}

	/**
	 * @param {string} method
	 * @param {object=} params
	 * @param {boolean=false} isNotification
	 * @returns {Promise<any>}
	 */
	async jsonRPC(method, params, isNotification) {
		if (!this.#messageUrl) await this.connect();

		let id;
		const body = { jsonrpc: '2.0', method, params };
		if (!isNotification) id = body.id = ++this.#reqId;

		return new Promise((resolve, reject) => {
			let result;
			const reqPromise = sseFetch(this.#messageUrl, {
				headers: this.#headers,
				body:    JSON.stringify(body),
				key:     this.options.key,
				signal:  this.#closer.signal
			}, (chunk, event) => {
				if (chunk.id === id) {
					if (chunk.error) {
						throw new Error(`JSON-RPC ${chunk.error.code}: ${chunk.error.message}`);
					}
					result = chunk.result;
				}
			});

			if (isNotification) return resolve();

			if (this.#transportMode === 'sse') {
				this.#pending.set(id, [ resolve, reject ]);

				reqPromise.catch(err => {
					this.#pending.delete(id);
					reject(err);
				});
			} else {
				reqPromise.then((resp) => {
					const sessionId = resp.headers.get('Mcp-Session-Id');
					if (sessionId) this.#headers = {'Mcp-Session-Id': sessionId};

					resolve(result);
				}, reject);
			}
		});
	}
}
