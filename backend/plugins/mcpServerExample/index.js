/**
 * MCP Example
 *
 * 将 MCPServer 挂载到后端 Router 架构中。
 * 放在 plugins/任意目录/index.js 并导出 default 函数的 JS 会被自动执行。
 *
 * 客户端可通过 MCPClient 连接:
 *   const client = new MCPClient('http://host:3000/api/mcp/example');
 *   await client.connect();
 *   const result = await client.callTool(...);
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {pipeline} from 'node:stream/promises';

const { MCPServer } = globalThis.AiChatAPI;

const mcp = new MCPServer({
	name: 'Example-MCP',
	version: '1.0.0',
});

// ─── 示例工具 ────────────────────────────────────────────
// 调用 handler 之前，inputSchema 会被验证

mcp.tool(
	'Download',
	'下载网络文件到本地。',
	{
		type: 'object',
		properties: {
			url: {
				type: 'string',
			},
			destination: {
				type: 'string',
				description: '本地保存路径',
			},
			headers: {
				type: 'object',
				description: '可选，自定义请求头（JSON 对象），会与默认 User-Agent 合并',
			},
			timeoutMs: {
				type: 'integer',
				default: 60000,
			},
			overwrite: {
				type: 'boolean',
				default: false
			},
		},
		required: ['url', 'destination']
	},
	async ({ url, destination, headers, timeoutMs = 60000, overwrite = false }) => {
		if (!overwrite) {
			try {
				const stat = await fsPromises.stat(destination);
				return MCPServer.toolError(`文件已存在: ${destination} (${stat.size} 字节)`);
			} catch {}
		}

		const destDir = path.dirname(destination);
		if (destDir) await fsPromises.mkdir(destDir, { recursive: true });

		const mergedHeaders = {
			'User-Agent': 'node',
			...headers
		};

		let redirects = 3;
		const doDownload = async (url) => new Promise((resolve, reject) => {
			let parsedUrl;
			try {
				parsedUrl = new URL(url);
			} catch {
				return reject(`无效的 URL: ${url}`);
			}

			const protocol = parsedUrl.protocol === 'https:' ? https : http;
			const req = protocol.request(url, {
				method: 'GET',
				headers: mergedHeaders,
				timeout: timeoutMs,
			}, async (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					if (--redirects <= 0) reject(`重定向过多`);

					const redirectUrl = new URL(res.headers.location, url).href;
					return resolve(doDownload(redirectUrl));
				}

				if (res.statusCode >= 400) {
					reject(`下载失败: HTTP ${res.statusCode}`);
					res.resume(); // 消耗响应体 LLM 写的 怎么中止
					return;
				}

				const writeStream = fs.createWriteStream(destination);
				try {
					await pipeline(res, writeStream);
					const stat = await fsPromises.stat(destination);
					resolve(`下载完成: ${destination} (${stat.size} 字节, 来源: ${url})`);
				} catch (err) {
					reject(`写入文件失败: ${err.message}`);
				}
			});

			req.on('timeout', () => {
				req.destroy();
				reject(`下载超时（${timeoutMs}ms）: ${url}`);
			});
			req.on('error', (err) => {
				reject(`下载错误: ${err.message}`);
			});
			req.end();
		});

		return doDownload(url).then(t => t, MCPServer.toolError);
	}
);

// ─── 示例资源 ────────────────────────────────────────────

mcp.resource(
	'config://server',
	'服务器信息',
	'application/json',
	async (uri, extra) => ({
		contents: [{
			uri,
			mimeType: 'application/json',
			text: JSON.stringify({
				name: mcp.serverInfo?.name || 'AiChat-MCP-Plugin',
				version: mcp.serverInfo?.version || '1.0.0',
				userId: extra.ctx?.params?.userId || null,
			}, null, 2),
		}],
	})
);

// ─── 示例 Prompt ─────────────────────────────────────────

mcp.prompt(
	'summarize',
	'生成摘要提示词',
	[
		{ name: 'topic', description: '摘要主题', required: true },
		{ name: 'length', description: '摘要长度（short/medium/long）', required: false },
	],
	async (args) => {
		const lengthGuide = {
			short: '一句话',
			medium: '一个段落',
			long: '三个段落',
		};
		const guide = lengthGuide[args.length] || lengthGuide.medium;

		return {
			messages: [{
				role: 'user',
				content: {
					type: 'text',
					text: `请用${guide}总结以下关于「${args.topic}」的内容。`,
				},
			}],
		};
	}
);

// ─── 导出插件入口 ────────────────────────────────────────

/**
 * 插件默认导出。接收 Router 实例，将 MCP Server 挂载上去。
 * @param {AiChatBackend.Router} router
 */
export default router => mcp.mount(router, 'mcp/example');
