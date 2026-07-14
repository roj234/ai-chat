import {validateAndShowError} from "unconscious/common/json-schema-utils.js";

/**
 * @typedef {Object} MCPServerOptions
 * @property {string} [name='MCPServer'] - 服务名称
 * @property {string} [version='1.0.0'] - 版本号
 * @property {object} [capabilities] - 额外能力声明
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - 工具名称
 * @property {string} description - 工具描述
 * @property {object} inputSchema - JSON Schema 参数定义
 * @property {Function} handler - (args, extra) => Promise<{content: Array, isError?: boolean}>
 */

/**
 * @typedef {Object} ResourceDefinition
 * @property {string} uri - 资源 URI
 * @property {string} name - 资源名称
 * @property {string} [description] - 资源描述
 * @property {string} [mimeType] - MIME 类型
 * @property {Function} handler - (uri, extra) => Promise<{contents: Array}>
 */

/**
 * @typedef {Object} PromptDefinition
 * @property {string} name - Prompt 名称
 * @property {string} [description] - Prompt 描述
 * @property {Array<{name:string, description?:string, required?:boolean}>} [arguments] - 参数列表
 * @property {Function} handler - (args, extra) => Promise<{messages: Array}>
 */

export class MCPServer {
	/** @type {Map<string, ToolDefinition>} */
	#tools = new Map();

	/** @type {Map<string, ResourceDefinition>} */
	#resources = new Map();

	/** @type {Map<string, PromptDefinition>} */
	#prompts = new Map();

	/** @type {Map<string, import('http').ServerResponse>} SSE 客户端连接 */
	#clients = new Map();

	/** @type {string} */
	#name;
	/** @type {string} */
	#version;

	/** @type {object} 服务器能力声明 */
	#capabilities;

	/** @type {{name:string, version:string}} 服务信息 */
	get serverInfo() { return { name: this.#name, version: this.#version }; }

	/**
	 * @param {MCPServerOptions} [options]
	 */
	constructor(options = {}) {
		this.#name = options.name || 'MCPServer';
		this.#version = options.version || '1.0.0';

		this.#capabilities = {
			tools: {},
			resources: {},
			prompts: {},
			...options.capabilities,
		};
	}

	// ─── 注册 API ────────────────────────────────────────

	/**
	 * 注册工具
	 * @param {string} name - 工具名称
	 * @param {string} description - 工具描述
	 * @param {OpenAI.ObjectSchema} inputSchema - JSON Schema 参数定义
	 * @param {function(object, object): Promise<{content:Array, isError?:boolean}>} handler
	 * @returns {this}
	 */
	tool(name, description, inputSchema, handler) {
		this.#tools.set(name, { name, description, inputSchema, handler });
		this.#capabilities.tools = { listChanged: true };
		return this;
	}

	/**
	 * 注册资源
	 * @param {string} uri - 资源 URI
	 * @param {string} name - 资源名称
	 * @param {string} mimeType - MIME 类型
	 * @param {string} [description] - 资源描述
	 * @param {function(string, object): Promise<{contents:Array}>} handler
	 * @returns {this}
	 */
	resource(uri, name, mimeType, description, handler) {
		if (typeof description === 'function') {
			handler = description;
			description = undefined;
		}
		this.#resources.set(uri, { uri, name, description, mimeType: mimeType || 'text/plain', handler });
		this.#capabilities.resources = { subscribe: false, listChanged: true };
		return this;
	}

	/**
	 * 注册 Prompt 模板
	 * @param {string} name - Prompt 名称
	 * @param {string} description - Prompt 描述
	 * @param {Array<{name:string, description?:string, required?:boolean}>} args - 参数列表
	 * @param {function(object, object): Promise<{messages:Array}>} handler
	 * @returns {this}
	 */
	prompt(name, description, args, handler) {
		this.#prompts.set(name, { name, description, arguments: args || [], handler });
		this.#capabilities.prompts = { listChanged: true };
		return this;
	}

	// ─── Router 插件挂载 ──────────────────────────────────

	/**
	 * 将 MCP Server 挂载到 Router 上。
	 *
	 * @param {AiChatBackend.Router} router - 后端 Router 实例
	 * @param {string} [prefix='mcp'] - 挂载路径前缀
	 * @returns {this}
	 */
	mount(router, prefix = 'mcp') {
		router.push(prefix);

		if (false) {
			// SSE
			router.get('', (ctx) => {
				const sessionId = crypto.randomUUID();
				const basePath = ctx.url.pathname.replace(/\/$/, '');
				const messageUrl = `${basePath}/message?session=${sessionId}`;

				ctx.res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive',
				});

				ctx.res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

				this.#clients.set(sessionId, ctx.res);

				ctx.req.on('close', () => {
					this.#clients.delete(sessionId);
				});
			});

			// SSE + JSON-RPC
			router.post('/message', async (ctx) => {
				const rpc = await ctx.readAsObject();
				try {
					const sessionId = ctx.searchParams.get('session');
					const sseRes = sessionId ? this.#clients.get(sessionId) : null;
					ctx.sessionId = sessionId;

					if (rpc.id == null) {
						ctx.send(202, '');
						return this.#dispatch(rpc, ctx);
					}

					const result = await this.#dispatch(rpc, ctx);
					const response = { jsonrpc: '2.0', id: rpc.id, result };

					// SSE 模式：通过 SSE 流返回结果
					if (sseRes) {
						sseRes.write(`data: ${JSON.stringify(response)}\n\n`);
						ctx.send(202, '');
					} else {
						ctx.send(200, response);
					}
				} catch (err) {
					const response = { jsonrpc: '2.0', error: { code: -32603, message: err.message || 'Internal error' } };
					ctx.send(err.status || 500, response);
				}
			});
		}

		// Streamable HTTP
		router.post('', async (ctx) => {
			const rpc = await ctx.readAsObject();
			try {
				const sessionId = ctx.req.headers['mcp-session-id'] || crypto.randomUUID();
				ctx.sessionId = sessionId;

				const result = await this.#dispatch(rpc, ctx);

				ctx.res.writeHead(200, {
					'Content-Type': 'application/json',
					'Mcp-Session-Id': sessionId,
				});
				ctx.res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
			} catch (err) {
				const response = { jsonrpc: '2.0', error: { code: -32603, message: err.message || 'Internal error' } };
				ctx.send(err.status || 500, response);
			}
		});

		// 断开会话
		router.delete('', (ctx) => {
			const sessionId = ctx.req.headers['mcp-session-id'];
			const res = this.#clients.get(sessionId);
			if (res) {
				res.end();
				this.#clients.delete(sessionId);
			}
			ctx.send(res ? 200 : 404, '');
		});

		router.pop();
		return this;
	}

	/**
	 * @param {object} rpc
	 * @param {object} ctx
	 * @returns {Promise<any>}
	 */
	async #dispatch(rpc, ctx) {
		const { method, params } = rpc;

		switch (method) {
			case 'initialize':
				return this.#handleInitialize(params);
			case 'notifications/initialized':
				return undefined;
			case 'tools/list':
				return this.#handleToolsList();
			case 'tools/call':
				return this.#handleToolCall(params, ctx);
			case 'resources/list':
				return this.#handleResourcesList();
			case 'resources/read':
				return this.#handleResourceRead(params, ctx);
			case 'prompts/list':
				return this.#handlePromptsList();
			case 'prompts/get':
				return this.#handlePromptGet(params, ctx);
			case 'completion/complete':
				return this.#handleCompletion(params, ctx);
			case 'ping':
				return {};
			default:
				throw Object.assign(new Error(`Method not found: ${method}`), { status: 404, code: -32601 });
		}
	}

	// ─── 核心方法实现 ─────────────────────────────────────

	#handleInitialize(params) {
		return {
			protocolVersion: params?.protocolVersion || '2025-03-26',
			capabilities: this.#capabilities,
			serverInfo: {
				name: this.#name,
				version: this.#version,
			},
		};
	}

	#handleToolsList() {
		const tools = [];
		for (const t of this.#tools.values()) {
			tools.push({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			});
		}
		return { tools };
	}

	async #handleToolCall(params, ctx) {
		const { name, arguments: args = {} } = params || {};
		const tool = this.#tools.get(name);
		if (!tool) throw Object.assign(new Error(`Tool not found: ${name}`), { status: 404, code: -32602 });

		try {
			const error = validateAndShowError(args, tool.inputSchema);
			if (error) throw error;

			const result = await tool.handler(args, ctx);
			return {
				content: result.content || [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
				isError: result.isError || false,
			};
		} catch (e) {
			if (typeof e !== 'string') console.error(e);
			return MCPServer.toolError(e.message || String(e));
		}
	}

	#handleResourcesList() {
		const resources = [];
		for (const r of this.#resources.values()) {
			resources.push({
				uri: r.uri,
				name: r.name,
				description: r.description,
				mimeType: r.mimeType,
			});
		}
		return { resources };
	}

	async #handleResourceRead(params, ctx) {
		const { uri } = params || {};
		const resource = this.#resources.get(uri);
		if (!resource) throw Object.assign(new Error(`Resource not found: ${uri}`), { status: 404, code: -32602 });

		const result = await resource.handler(uri, ctx);
		return { contents: result.contents || [] };
	}

	#handlePromptsList() {
		const prompts = [];
		for (const p of this.#prompts.values()) {
			prompts.push({
				name: p.name,
				description: p.description,
				arguments: p.arguments,
			});
		}
		return { prompts };
	}

	async #handlePromptGet(params, ctx) {
		const { name, arguments: args } = params || {};
		const prompt = this.#prompts.get(name);
		if (!prompt) throw Object.assign(new Error(`Prompt not found: ${name}`), { status: 404, code: -32602 });

		const result = await prompt.handler(args || {}, ctx);
		return {
			description: prompt.description,
			messages: result.messages || [],
		};
	}

	/**
	 * 参数自动补全 (默认返回空)
	 */
	async #handleCompletion(params, ctx) {
		const { ref, argument } = params || {};

		// 默认实现：返回空补全列表
		return {
			completion: {
				values: [],
				total: 0,
				hasMore: false,
			},
		};
	}

	// ─── SSE 广播 ─────────────────────────────────────────

	/**
	 * 向所有 SSE 客户端发送通知
	 * @param {string} method - 通知方法名
	 * @param {object} [params] - 通知参数
	 */
	notify(method, params) {
		const data = JSON.stringify({ jsonrpc: '2.0', method, params });
		for (const res of this.#clients.values()) {
			try {
				res.write(`data: ${data}\n\n`);
			} catch {
				// 客户端已断开，忽略
			}
		}
	}

	/**
	 * 通知工具列表已变更
	 */
	notifyToolsChanged() {
		this.notify('notifications/tools/list_changed');
	}

	/**
	 * 通知资源列表已变更
	 */
	notifyResourcesChanged() {
		this.notify('notifications/resources/list_changed');
	}

	/**
	 * 通知 Prompt 列表已变更
	 */
	notifyPromptsChanged() {
		this.notify('notifications/prompts/list_changed');
	}

	/**
	 *
	 * @param text
	 * @returns {{isError: boolean, content: [{text, type: string}]}}
	 */
	static toolError(text) {
		return { content: [{ type: 'text', text }], isError: true };
	}
}

export default MCPServer;
