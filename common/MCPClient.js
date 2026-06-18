
export class MCPClient {
	statusListener;

	/** @type {string} */
	#baseUrl;
	#options;
	/** @type {EventSource} */
	#sse;
	/** @type {string} 消息端点 URL */
	#messageUrl;
	/** @type {Error} */
	#error;

	#connectPromise;

	/** @type {object|null} 服务器信息 */
	#serverInfo = null;

	/** @type {number} JSON-RPC 请求 ID 自增 */
	#reqId = 0;
	/** @type {Map<number, {resolve,reject,timer}>} */
	#pending = new Map();

	/**
	 * @param {string} baseUrl
	 * @param {Object} options
	 */
	constructor(baseUrl, options = {}) {
		this.#baseUrl = baseUrl.replace(/\/$/, '');
		this.#options = options;
	}

	get isOpen() { return this.#sse?.readyState === EventSource.OPEN; }
	get readyState() { return this.#sse?.readyState ?? EventSource.CLOSED; }
	get serverInfo() { return this.#serverInfo; }
	get lastError() { return this.#error; }

	/**
	 * @returns {Promise<object>}
	 */
	async connect() {
		if (this.isOpen) throw new Error("已连接");

		let doConnect = this.#connectPromise;
		if (doConnect) return doConnect.then(() => this.#serverInfo);

		let _resolve, _reject;
		doConnect = new Promise((resolve, reject) => {
			_resolve = resolve;
			_reject = reject;
		});
		this.#connectPromise = doConnect;

		let timeout = setTimeout(() => {
			_reject(new Error('SSE 连接超时'));
			sse.close();
		}, 10000);

		const sse = new EventSource(`${this.#baseUrl}/sse`);
		sse.addEventListener("close", () => {
			const reason = this.#error || new Error('SSE 流断开');
			_reject(reason);

			for (const [ , reject ] of this.#pending.values()) reject(reason);
			this.#pending.clear();

			this.disconnect();

			this.statusListener?.(this.isOpen);
		});
		sse.addEventListener("message", (e) => {
			try {
				const msg = JSON.parse(e.data);
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
		});
		sse.addEventListener("endpoint", ({data}) => {
			clearTimeout(timeout);
			this.#messageUrl = new URL(data, this.#baseUrl).href;
			_resolve();
		});

		try {
			this.#sse = sse;
			await doConnect;

			// 握手
			const handshake = await this.jsonRPC('initialize', {
				protocolVersion: '2024-11-05',
				capabilities:    {},
				clientInfo:      {
					name:    APP_NAME,
					version: APP_VERSION,
				},
			});
			this.#serverInfo = handshake;
			this.statusListener?.(this.isOpen);

			await this.sendNotification("notifications/initialized");
			return handshake;
		} catch (err) {
			this.#connectPromise = null;
			this.disconnect(err);
			throw err;
		}
	}

	disconnect(reason) {
		this.#error = reason;
		this.#sse?.close();
		this.#sse = null;
		this.#messageUrl = null;
		this.#serverInfo = null;
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
	 */
	async sendNotification(method, params) {
		if (!this.#messageUrl) await this.connect();
		const body = JSON.stringify({ jsonrpc: '2.0', method, params });
		await fetch(this.#messageUrl, {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
	}

	/**
	 * @param {string} method
	 * @param {object=} params
	 * @returns {Promise<any>}
	 */
	async jsonRPC(method, params) {
		if (!this.#messageUrl) await this.connect();

		const id = ++this.#reqId;
		const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

		return new Promise((resolve, reject) => {
			this.#pending.set(id, [ resolve, reject ]);

			fetch(this.#messageUrl, {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			}).then(resp => {
				if (!resp.ok) throw "HTTP "+resp.status;
			}).catch(err => {
				this.#pending.delete(id);
				reject(err);
			});
		});
	}
}
