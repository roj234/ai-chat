import {
	SSE_PROXY_BACKEND,
	SSE_PROXY_MODERATION,
	SSE_PROXY_TRACE,
	SSE_REF_CACHE_SIZE,
	SSE_REF_TTL,
	SSE_RESUME_TIMEOUT
} from "../config.js";
import {EventEmitter} from "node:events";
import {applyDelta, sseFetch} from "../../common/openai-api-utils.js";
import fs from "node:fs/promises";
import {openAsBlob} from "node:fs";
import path from "node:path";
import {Transform} from 'node:stream';
import {createSocks5Agent} from "../utils/socks5-agent.js";
import {LRUCache} from "../../common/LRUCache.js";
import {createJsonStream} from "../../common/StreamJsonSerializer.js";
import {deepEntries} from "unconscious/common/json-schema-utils.js";
import {isLanAddress} from "../../common/isLanAddress.js";

const log = (str, ...args) => console.log(`[SSE Proxy] `+str, ...args);

const proxyCache = new Map;
const getProxyAgent = (proxyUrl) => {
	if (!proxyUrl) return; // undefined
	let proxyAgent = proxyCache.get(proxyUrl);
	if (!proxyAgent) {
		proxyCache.set(proxyUrl, proxyAgent = createSocks5Agent(proxyUrl));
	}
	return proxyAgent;
}

const agentOptions = {
	keepAlive: true,
	//keepAliveMsecs: 1000,
	freeSocketTimeout: 60000,
	scheduling: 'lifo',
	maxSockets: 100
};

/**
 *
 * @type {Map<string, AiChatBackend.SSEProxyRequest>}
 */
const activeRequests = new Map;

/**
 * 消息引用缓存：hash -> 完整消息对象
 * 命中后客户端无需重复上传历史消息内容，仅引用 hash
 */
const messageCache = new LRUCache(SSE_REF_CACHE_SIZE);

/**
 * @param {OpenAI.Message[]} messages
 * @param {string} blobDir
 * @returns {Promise<[OpenAI.Message[], string[]]>}
 */
async function processMessageRefs(messages, blobDir) {
	const missing = new Set;
	const created = new Set;
	const output = [];

	let blockIndex, blockHash;

	const endCacheBlock = () => {
		if (blockHash) {
			if (blockIndex === i) throw new Error("Empty cache_block");
			messageCache.set(blockHash, messages.slice(blockIndex, i), SSE_REF_TTL);
			created.add(blockHash);
			blockHash = null;
		}
	};

	let i = 0;
	for (; i < messages.length; i++) {
		const m = messages[i];

		if (m.role === 'cache_end') {
			endCacheBlock();
		} else if (m.role === 'cached') {
			endCacheBlock();

			const cached = messageCache.get(m.id);
			if (!cached) missing.add(m.id);
			else output.push(...cached);
		} else if (m.role === 'cache_new') {
			endCacheBlock();

			blockHash = m.id;
			if (!blockHash) throw new Error("Invalid hash in cache_block");
			blockIndex = i+1;
		} else {
			output.push(m);
		}
	}
	endCacheBlock();

	if (missing.size) return [null, [...missing]];

	const tasks = [];

	for (const [val, own, key] of deepEntries(output)) {
		if (val?.$ === 'BlobH') {
			const hash = val.hash;
			const filePath = path.join(blobDir, hash.slice(0, 2).toLowerCase(), hash);

			tasks.push(fs.access(filePath).then(() => openAsBlob(filePath).then((blob) => own[key] = blob), e => {
				throw new Error("附件 "+(val.name || hash)+" 丢失或损坏");
			}));
		}
	}
	await Promise.all(tasks);

	return [output, [...created]];
}

function checkToken(ctx) {
	let {authorization} = ctx.req.headers;
	if (!authorization?.startsWith("Bearer ")) return ctx.send(403, { error: 'unknown key' });
	authorization = authorization.slice(7);

	let url, proxy;
	let target = SSE_PROXY_BACKEND[authorization] || SSE_PROXY_BACKEND['default'];
	if (!target?.url) return ctx.send(403, { error: 'unknown key' });
	if (!target.authorization) {
		target = {
			...target,
			authorization
		}
	}

	return target;
}

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
	//'created'
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
	let result = checkToken(ctx);
	if (!result) return;
	let {url: baseUrl, authorization, proxy: proxyUrl, headers, trace} = result;
	if (!baseUrl.endsWith("/")) baseUrl += '/';

	const moderation = SSE_PROXY_MODERATION(baseUrl, authorization, ctx);
	if (moderation && typeof moderation !== "function") {
		ctx.send(400, moderation);
		return;
	}

	const MAX_BODY_LENGTH = 20971520;
	let body;
	let duplex;
	const needTrace = SSE_PROXY_TRACE && trace;
	if (needTrace || blobDir || moderation) {
		body = await ctx.readAsString(MAX_BODY_LENGTH);
	} else {
		body = createLimiter(ctx.req, MAX_BODY_LENGTH);
		duplex = 'half';
	}
	// body 在 refs 路由中稍后会被替换成 ReadableStream。trace 必须保留原始
	// 请求字符串；否则日志写入和 fetch 会同时消费同一个流，导致流被锁定。
	const traceBody = needTrace ? body : null;

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

	let completion = {};
	/** @type {AiChatBackend.SSEProxyRequest} */
	let proxyRequest;
	function writeTrace(data) {
		return proxyRequest._append = proxyRequest._append.then(() =>
			fs.appendFile(proxyRequest._fileName, '\n' + data)
		, err => log('写入 trace 失败', err));
	}
	function sendChunk(serialized) {
		if (!ctx.res.closed) ctx.res.write(`data: ${serialized}\n\n`);
		// log every chunk
		if (needTrace === 'packet') writeTrace(serialized);
		proxyRequest.event.emit('data', serialized);
	}

	let hasError;
	const startTime = Date.now();
	const abort = new AbortController();

	try {
		const optionalParams = baseUrl+apiPath;
		if (needTrace) log('请求发送', optionalParams);

		ctx.res.on('close', () => {
			if (!proxyRequest) abort.abort();
		});

		await sseFetch(optionalParams, {
			body,
			duplex,
			headers,
			signal: abort.signal,
			agent: getProxyAgent(proxyUrl),
			key: authorization
		}, (chunk, isPlainJson) => {
			const now = Date.now();
			const id = chunk.id;

			if (isPlainJson === '\0') {
				if (firstChunk) Object.assign(chunk, firstChunk);
				const response = JSON.stringify(chunk);

				// non-stream response
				if (needTrace) {
					const fileName = `${logPath}/${encodeURIComponent(id)}_${now%1000}.jsonl`;
					fs.mkdir(logPath, {recursive: true})
						.then(() => fs.appendFile(fileName, traceBody))
						.then(() => fs.appendFile(fileName, '\n'))
						.then(() => fs.appendFile(fileName, response))
						.catch(err => log('写入 trace 失败', err));
				}

				ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
				ctx.res.write(response);
				return;
			}

			if (!proxyRequest) {
				log('响应开始', id);
				if (null == id) return;

				activeRequests.set(id, proxyRequest = {
					id,
					abort,
					data: completion,
					event: new EventEmitter,
					isFinished: false
				});

				if (needTrace) {
					const fileName = `${logPath}/${encodeURIComponent(id)}_${now%1000}.jsonl`;
					proxyRequest._fileName = fileName;
					proxyRequest._append = fs.mkdir(logPath, {recursive: true})
						.then(() => fs.appendFile(fileName, traceBody))
						.catch(err => log('写入 trace 失败', err));
				}

				ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				if (firstChunk) sendChunk(JSON.stringify(firstChunk));

				completion.resumable = chunk.resumable = { start: startTime, now };
			}

			proxyRequest.lastUpdated = now;

			const {choices, text, ...rest} = chunk;
			if (choices) {
				let out_choices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++){
					const {delta, ...rest} = choices[i];
					if (!out_choices[i]) out_choices[i] = { delta: {} };

					// reasoning end
					const resumable = completion.resumable;
					if (null == resumable.ft && (delta.content || delta.reasoning || delta.reasoning_details || delta.reasoning_content || delta.tool_calls)) {
						resumable.now = resumable.ft = now;
						chunk.resumable = resumable;
					}

					if (delta.reasoning && delta.reasoning === delta.reasoning_content) {
						delete delta.reasoning;
					}

					if (null == resumable.re && delta.content) {
						resumable.now = resumable.re = now;
						chunk.resumable = resumable;
					}

					Object.assign(out_choices[i], rest);
					applyDelta(out_choices[i].delta, delta);
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
			sendChunk(JSON.stringify(chunk));
		});
	} catch (err) {
		const id = proxyRequest?.id;
		if (err.name === 'AbortError') {
			log('请求中止', id);
		} else {
			if (err.message === "fetch failed") {
				err = err.cause;
			}

			log('请求出错', id, err);

			let {status = 500, message} = err;
			try {
				message = JSON.parse(message);
			} catch {}
			const obj = message.error ? message : { error: message };

			if (proxyRequest) {
				sendChunk(JSON.stringify(obj));
			} else {
				ctx.send(status, obj);
			}
			hasError = true;

			// 确保源连接被释放，避免 hang 住
			ctx.req.destroy();
		}
	} finally {
		if (proxyRequest) {
			if (!hasError) log('响应结束', proxyRequest.id);

			completion.resumable.end = true;
			proxyRequest.isFinished = true;
			proxyRequest.event.emit('end');
			proxyRequest.event.removeAllListeners();

			proxyRequest.timeoutId = setTimeout(() => {
				activeRequests.delete(proxyRequest.id);
			}, SSE_RESUME_TIMEOUT);

			if (needTrace === true) {
				await writeTrace(JSON.stringify(proxyRequest.data));
			}
		}
		abort.abort();

		if (!hasError && !ctx.res.closed) ctx.res.end();
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

	router.post("/models/wipe_cache", (ctx) => {
		messageCache.clear();
		modelCache.clear();
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

	router.post('/resume/:id', async (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id);
		if (!state) return ctx.send(404, { error: "no such session" });

		ctx.res.setHeader('Content-Type', 'text/event-stream');

		const {data, event, isFinished} = state;

		const onData = (text) => {ctx.res.write(`data: ${text}\n\n`);};
		const onEnd = () => {
			ctx.res.write(`data: [DONE]\n\n`);
			ctx.res.end();
		}

		// 如果是多线程，这里可能需要加锁，但是JS是谦让式协程，所以没什么好担心的
		if (!data.resumable.end) data.resumable.now = Date.now();
		onData(JSON.stringify(data));
		if (isFinished) { onEnd(); return; }

		event.on('data', onData);
		event.once('end', onEnd);

		ctx.res.on('close', () => {event.off('data', onData);});
	});

	router.get('/trace/:id', async (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id);

		if (state) {
			return ctx.send(200, state);
		}

		ctx.send(404, { error: "no such session" });
	});

	router.post('/abort/:id', async (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id);

		if (state) {
			clearTimeout(state.timeoutId);
			activeRequests.delete(id);
			state.abort.abort(); // 停止向 OpenAI 请求
			return ctx.send(200, { success: true });
		}
		ctx.send(404, { error: "no such session" });
	});

	router.get("/resume/list", (ctx) => {
		ctx.send(200, { sessions: [...activeRequests.keys()] });
	});
}