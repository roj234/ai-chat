import {SSE_PROXY_BACKEND, SSE_PROXY_TRACE, SSE_RESUME_TIMEOUT} from "../config.js";
import {EventEmitter} from "node:events";
import {applyDelta, streamFetch} from "../../common/openai-api-utils.js";
import fs from "node:fs/promises";
import path from "node:path";
import {Transform} from 'node:stream';

/**
 *
 * @type {Map<string, AiChatBackend.SSEProxyRequest>}
 */
const activeRequests = new Map;

function authorize(ctx) {
	let {authorization} = ctx.req.headers;
	if (!authorization?.startsWith("Bearer ")) return ctx.send(403, { error: 'unknown key' });
	authorization = authorization.slice(7);

	let url;
	let backend = SSE_PROXY_BACKEND[authorization];
	if (backend) {
		url = backend.url;
		authorization = backend.authorization;
	} else {
		backend = SSE_PROXY_BACKEND['default'];
		if (!backend) return ctx.send(403, { error: 'unknown key' });

		url = backend.url;
		if (backend.authorization) authorization = backend.authorization;
	}

	if (!url) return ctx.send(403, { error: 'unknown key' });
	return [url, authorization];
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

/**
 *
 * @param {string} logPath
 * @param {AiChatBackend.RouteContext} ctx
 * @return {Promise<void>}
 */
async function SSEHandler(logPath, ctx) {
	let result = authorize(ctx);
	if (!result) return;
	const [url, authorization] = result;

	const MAX_BODY_LENGTH = 20971520;
	const needBlobProxy = ctx.searchParams.has("blobProxy");
	let body;
	let duplex;
	if (SSE_PROXY_TRACE || needBlobProxy) {
		body = await ctx.readAsString(MAX_BODY_LENGTH);
	} else {
		body = createLimiter(ctx.req, MAX_BODY_LENGTH);
		duplex = 'half';
	}
	const abort = new AbortController();

	let completion = {};
	/** @type {AiChatBackend.SSEProxyRequest} */
	let proxyRequest;

	ctx.res.on('close', () => {
		if (!proxyRequest) abort.abort();
	});

	let hasError;
	const startTime = Date.now();
	try {
		/*if (needBlobProxy) {
			const obj = JSON.parse(body);

			body = new ReadableStream
		}*/

		await streamFetch(url+'/chat/completions', {
			body,
			duplex,
			signal: abort.signal,
			key: authorization
		}, chunk => {
			if (!proxyRequest) {
				const id = chunk.id;
				activeRequests.set(id, proxyRequest = {
					id,
					abort,
					data: completion,
					event: new EventEmitter,
					isFinished: false
				});
				console.log('SSE代理请求开始', id);

				if (SSE_PROXY_TRACE) {
					const fileName = `${logPath}/${encodeURIComponent(id)}_${Date.now()%1000}.jsonl`;
					proxyRequest._fileName = fileName;
					proxyRequest._inputPromise = fs.appendFile(fileName, body);
				}

				ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream' });

				chunk.resumable = { start: startTime, ft: Date.now() };
			}

			if (!ctx.res.closed) ctx.res.write(`data: ${JSON.stringify(chunk)}\n\n`);

			proxyRequest.event.emit('data', chunk);

			const {choices, text, ...rest} = chunk;
			if (choices) {
				let out_choices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++){
					const {delta, ...rest} = choices[i];
					if (!out_choices[i]) out_choices[i] = { delta: {} };

					Object.assign(out_choices[i], rest);
					applyDelta(out_choices[i].delta, delta);
				}
			} else {
				completion.text = (completion.text || "") + text;
			}
			Object.assign(completion, rest);
		});
	} catch (err) {
		if (err.name === 'AbortError') {
			console.log('SSE代理请求中止');
		} else {
			console.log('SSE代理请求出错', err);

			const {status = 500, message} = err;
			let obj = {
				upstream_error: message
			};
			try {
				obj = JSON.parse(message);
			} catch {}

			ctx.send(status, obj);
			hasError = true;

			// 确保源连接被释放，避免 hang 住
			ctx.req.destroy();
		}
	} finally {
		if (proxyRequest) {
			proxyRequest.isFinished = true;
			proxyRequest.event.emit('end');
			proxyRequest.event.removeAllListeners();

			completion.resumable.end = true;
			console.log('SSE代理请求结束', proxyRequest.id);

			proxyRequest.timeoutId = setTimeout(() => {
				activeRequests.delete(proxyRequest.id);
			}, SSE_RESUME_TIMEOUT);

			if (SSE_PROXY_TRACE) {
				await proxyRequest._inputPromise.then(() =>
					fs.appendFile(proxyRequest._fileName, '\n' + JSON.stringify(proxyRequest.data))
				);
			}
		}
		abort.abort();

		if (!hasError && !ctx.res.closed) ctx.res.end();
	}
}

const modelCache = new Map;

/**
 * @param {AiChatBackend.Router} router
 * @param {string} dataPath
 */
export function registerSSEProxyRoutes(router, dataPath) {
	const logPath = path.join(dataPath, "logs");
	if (SSE_PROXY_TRACE) fs.mkdir(logPath, {recursive: true});

	router.post("/models/wipe_cache", (ctx) => {
		modelCache.clear();
		ctx.send(200, { success: true });
	});

	router.get('/models', async (ctx) => {
		let result = authorize(ctx);
		if (!result) return;
		const [url, authorization] = result;

		const key = url+"|"+authorization;
		const res = ctx.res;
		let cache = modelCache.get(key);
		if (!cache || Date.now() - cache.time > 3600000) {
			const proxyRes = await fetch(url+'/models', { headers: {
				accept: "application/json",
				authorization: "Bearer "+authorization,
			} });

			const data = await proxyRes.text();

			if (!proxyRes.ok) {
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
	router.post('/chat/completions', SSEHandler.bind(null, logPath));
	router.post('/completions', SSEHandler.bind(null, logPath));

	router.post('/resume/:id', async (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id);
		if (!state) return ctx.send(404, { success: false, error: "SSE代理会话已过期" });

		ctx.res.setHeader('Content-Type', 'text/event-stream');

		const {data, event, isFinished} = state;

		const onData = (json) => {ctx.res.write(`data: ${JSON.stringify(json)}\n\n`);};
		const onEnd = () => {
			ctx.res.write(`data: [DONE]\n\n`);
			ctx.res.end();
		}

		// 如果是多线程，这里可能需要加锁，但是JS是谦让式协程，所以没什么好担心的
		onData(data);
		if (isFinished) { onEnd(); return; }

		event.on('data', onData);
		event.once('end', onEnd);

		ctx.res.on('close', () => {event.off('data', onData);});
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
		ctx.send(404, { success: false, error: "SSE代理会话已过期" });
	});

	router.get("/resume/list", (ctx) => {
		ctx.send(200, { sessions: [...activeRequests.keys()] });
	});
}