import {SSE_PROXY_MODERATION, SSE_REF_CACHE_SIZE} from "../config.js";
import {applyDelta, sseFetch} from "../../common/fetch-utils.js";
import fs from "node:fs/promises";
import path from "node:path";
import {Transform} from 'node:stream';
import {createJsonStream} from "../../common/StreamJsonSerializer.js";
import {deepEntries} from "unconscious/common/json-schema-utils.js";
import {isLanAddress} from "../../common/isLanAddress.js";
import {getProxyAgent} from "../utils/socks5-agent.js";
import {responsesProxyHandler} from "./api-proxy-responses.js";
import {apiProxyLog as log, checkToken, processMessageRefs} from "./api-proxy-utils.js";
import {finishedRequests, ProxyResumeManager, registerResumeRoutes} from "./api-proxy-resume.js";

/**
 * 创建一个限制大小的可读流
 * @param {import('stream').Readable} source 源请求可读流（ctx.req）
 * @param {number} maxLength 最大字节数
 * @returns {Transform} 可直接作为 fetch body 的流
 */
function createLimiter(source, maxLength) {
	let totalLength = 0;

	const limited = new Transform({
		transform(chunk, encoding, callback) {
			totalLength += chunk.length;
			if (totalLength > maxLength) {
				const err = new Error('Request body too large');
				err.status = 413;
				source.destroy();
				return callback(err);
			}

			this.push(chunk);
			callback();
		},

		destroy(err, callback) {
			source.destroy();
			callback(err);
		},
	});

	source.pipe(limited);
	source.on('error', (e) => limited.destroy(e));

	return limited;
}

const ONCE_KEYS = [
	'id',
	'object',
	'model',
	'system_fingerprint',
	'created'
];

/**
 *
 * @param {string} logPath
 * @param {string} apiPath
 * @param {AiChatBackend.RouteContext} ctx
 * @param {string} blobDir blob 存储目录（用于展开消息中的 Blob 引用）
 * @return {Promise<void>}
 */
async function SSEHandler(logPath, apiPath, blobDir, ctx) {
	let target = checkToken(ctx);
	if (!target) return;
	const format = target.format ?? 'openai';
	if (format === 'responses') return responsesProxyHandler(target, logPath, blobDir, ctx);
	if (format !== 'openai') return ctx.send(500, { error: "unsupported format "+format })

	let {url: baseUrl, authorization, proxy: proxyUrl, headers, trace} = target;
	if (!baseUrl.endsWith("/")) baseUrl += '/';

	const moderation = SSE_PROXY_MODERATION(baseUrl, authorization, ctx);
	if (moderation && typeof moderation !== "function") return ctx.send(400, moderation);

	const MAX_BODY_LENGTH = 20971520;
	let body;
	let duplex;
	if (trace || blobDir || moderation) {
		body = await ctx.readAsString(MAX_BODY_LENGTH);
	} else {
		body = createLimiter(ctx.req, MAX_BODY_LENGTH);
		duplex = 'half';
	}
	// body 在 refs 路由中稍后会被替换成 ReadableStream。trace 必须保留原始
	// 请求字符串；否则日志写入和 fetch 会同时消费同一个流，导致流被锁定。
	const traceBody = trace ? body : null;

	let firstChunk;
	if (blobDir || moderation) {
		const obj = JSON.parse(body);

		if (!Array.isArray(obj.messages) || !obj.messages.every(item => typeof item === 'object' && item.role)) {
			ctx.send(400, { error: "bad messages array" });
			return;
		}

		if (moderation) {
			const result = await moderation(obj);
			if (result) {
				ctx.send(400, result);
				return;
			}
		}

		if (blobDir) {
			const [messages, result] = await processMessageRefs(obj.messages, blobDir);
			if (!messages) {
				ctx.send(409, {
					error: 'cache_expired',
					hashes: result
				});
				return;
			}

			firstChunk = { new_cached: result };

			obj.messages = messages;
			if (obj.cache_only) {
				ctx.send(201, firstChunk);
				return;
			}
		}

		body = createJsonStream(obj);
		//duplex = 'half';
	}

	const extraHeaders = {};
	for (let key in ctx.req.headers) {
		/// for OpenRouter attribution and/or DSH fake
		if (key.startsWith("x-") || key === "http-referer") {
			extraHeaders[key] = ctx.req.headers[key];
		}
	}

	const pm = new ProxyResumeManager(ctx, body, trace && logPath);
	const completion = pm.completion;

	try {
		const optionalParams = baseUrl+apiPath;

		ctx.res.once('close', () => pm.end());

		await sseFetch(optionalParams, {
			body,
			duplex,
			headers: {
				...extraHeaders,
				...headers
			},
			signal: pm.abort.signal,
			agent: getProxyAgent(proxyUrl),
			key: authorization
		}, (chunk, eventType) => {
			const now = Date.now();
			const id = chunk.id;

			if (eventType === '\0') {
				if (firstChunk) Object.assign(chunk, firstChunk);
				const response = JSON.stringify(chunk);

				// non-stream response
				if (trace) {
					const fileName = `${logPath}/${encodeURIComponent(id)}_${now%1000}.jsonl`;
					fs.mkdir(logPath, {recursive: true})
						.then(() => fs.appendFile(fileName, traceBody))
						.then(() => fs.appendFile(fileName, '\n'))
						.then(() => fs.appendFile(fileName, response))
						.catch(err => log('写入 trace 失败', err));
				}

				ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
				ctx.res.end(response);
				return;
			}

			if (!pm.req) {
				if (null == id) return;
				chunk.resumable = pm.begin(id);
				if (firstChunk) pm.send(JSON.stringify(firstChunk));
			}

			const {choices, text, ...rest} = chunk;
			if (choices) {
				let compChoices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++){
					const {delta, ...rest} = choices[i];
					let compChoice = compChoices[i];
					if (!compChoice) compChoice = compChoices[i] = { delta: {} };

					const reasoning = delta.reasoning;

					// reasoning end
					const resumable = completion.resumable;
					if (null == resumable.ft && (delta.content || reasoning || delta.reasoning_details || delta.reasoning_content || delta.tool_calls)) {
						resumable.now = resumable.ft = now;
						chunk.resumable = resumable;
					}

					if (reasoning && reasoning === delta.reasoning_content) delete delta.reasoning;

					const role = delta.role;
					if (role && role === compChoice.delta.role) delete delta.role;

					if (null == resumable.re && (delta.content || delta.tool_calls)) {
						resumable.now = resumable.re = now;
						chunk.resumable = resumable;
					}

					Object.assign(compChoice, rest);
					applyDelta(compChoice.delta, delta);
				}
			} else {
				completion.text = (completion.text || "") + text;
			}

			for (let [val, own, key] of deepEntries(chunk)) {
				if (val === null || val === '' || (typeof val === 'object' && !Object.keys(val).length))
					delete own[key];
			}
			for (const key of ONCE_KEYS) {
				if (completion[key]) delete chunk[key];
			}

			Object.assign(completion, rest);
			pm.send(JSON.stringify(chunk));
		});
	} catch (err) {
		pm.onError(err);
	} finally {
		pm.end(true);
	}
}

/**
 * @param {string} itf
 * @param {AiChatBackend.RouteContext} ctx
 * @return {Promise<void>}
 */
export async function proxyHandler(itf, ctx) {
	let result = checkToken(ctx);
	if (!result) return;

	let {url: baseUrl, authorization, proxy: proxyUrl, headers} = result;
	if (!baseUrl.endsWith("/")) baseUrl += '/';

	const res = ctx.res;

	if (!isLanAddress(baseUrl)) {
		res.writeHead(204, {
			vary: "Authorization",
			"cache-control": "public"
		});
		res.end();
		return;
	}

	const method = ctx.req.method;
	let body, duplex;
	if (method === 'POST') {
		body = createLimiter(ctx.req, 1048576);
		duplex = 'half';
	}

	const proxyRes = await fetch(baseUrl+'../'+itf, {
		headers: {
			accept: "application/json",
			authorization: "Bearer "+authorization,
			...headers
		},
		method,
		body,
		duplex,
		//as this is a LAN address, we don't need proxy (really?)
		agent: getProxyAgent(proxyUrl)
	});

	res.writeHead(proxyRes.status, proxyRes.headers);
	for await (const chunk of proxyRes.body) res.write(chunk);
	res.end();
}


const modelCache = new Map;

/**
 * @param {AiChatBackend.Router} router
 * @param {string} dataPath
 */
export function registerSSEProxyRoutes(router, dataPath) {
	const logPath = path.join(dataPath, "logs");
	const blobDir = path.join(dataPath, "blobs");

	// 调试用
	router.delete("/cache", (ctx) => {
		modelCache.clear();
		finishedRequests.clear();
		ctx.send(200, { success: true });
	});

	router.get('/models', async (ctx) => {
		let result = checkToken(ctx);
		if (!result) return;
		let {url: baseUrl, authorization, proxy: proxyUrl, headers} = result;
		if (!baseUrl.endsWith("/")) baseUrl += '/';

		const key = baseUrl+"|"+authorization;
		const res = ctx.res;
		let cache = modelCache.get(key);
		if (!cache || Date.now() - cache.time > 3600000) {
			const proxyRes = await fetch(baseUrl+'models', {
				headers: {
					accept: "application/json",
					authorization: "Bearer "+authorization,
					...headers
				},
				agent: getProxyAgent(proxyUrl)
			});

			const data = await proxyRes.text();

			// 本地端点不缓存（如辣妈洗屁屁）
			if (!proxyRes.ok || isLanAddress(baseUrl)) {
				res.writeHead(proxyRes.status, proxyRes.headers);
				res.end(data);
				return
			}

			modelCache.set(key, cache = {
				time: Date.now(),
				data
			})
		}

		res.writeHead(200, { 'Content-Type': "application/json" });
		res.end(cache.data);
	});
	if (SSE_REF_CACHE_SIZE > 0) router.post('/chat/completions/refs', SSEHandler.bind(null, logPath, "chat/completions", blobDir));
	router.post('/chat/completions', SSEHandler.bind(null, logPath, "chat/completions", null));
	router.post('/completions', SSEHandler.bind(null, logPath, "completions", null));

	registerResumeRoutes(router);
}