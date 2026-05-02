import {SSE_PROXY_BACKEND} from "../config.js";

/**
 *
 * @type {Map<string, AIChatBackend.SSEProxyRequest>}
 */
const activeRequests = new Map;


import {EventEmitter} from "node:events";

/**
 *
 * @param {string} url
 * @param {RequestInit & { authorization?: string }} data
 * @param {function(OpenAI.Response): void} onToken
 * @param {function(): boolean} shouldCancel
 * @return {Promise<void>}
 */
function streamFetch(url, data = {}, onToken, shouldCancel) {
	return fetch(url, {
		method: "POST",
		headers: {
			'Content-Type': "application/json",
			'Authorization': data.authorization||""
		},
		referrerPolicy: 'no-referrer',
		...data
	}).then(async res => {
		if (!res.ok) {
			const err = await res.text();
			throw {
				message: err,
				code: res.status
			};
		}

		const reader = res.body.getReader();

		const decoder = new TextDecoder();
		let buf = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (shouldCancel()) break;

				buf += decoder.decode(value, { stream: true });

				const lines = buf.split("\n");
				buf = lines.pop() || '';
				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);
						if (data === '[DONE]') return;

						const json = JSON.parse(data);
						let error = json.error?.message;
						try {
							onToken(json);
						} catch (e) {
							if (!error)
								error = e;
						}

						if (error) throw error;
					}
				}
			}
		} finally {
			await reader.cancel();
		}
	});
}

function applyDelta(chunk, delta) {
	for (const item in delta) {
		if (typeof(delta[item]) === "object") {
			if (delta[item] == null) continue;

			if (!chunk[item])
				chunk[item] = Array.isArray(delta[item]) ? [] : {};
			applyDelta(chunk[item], delta[item]);
		} else if (null == chunk[item]) {
			chunk[item] = delta[item];
		} else {
			chunk[item] += delta[item];
		}
	}
}


function authorize(ctx) {
	let {authorization} = ctx.req.headers;
	if (!authorization) return ctx.send(403, { error: 'unknown key' });

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

	return [url, authorization];
}

async function SSEHandler(ctx) {
	let result = authorize(ctx);
	if (!result) return;
	const [url, authorization] = result;

	const params = await ctx.readBody();
	const abort = new AbortController();

	let completion = {};
	/**
	 * @type {AIChatBackend.SSEProxyRequest}
	 */
	let proxyRequest;

	try {
		await streamFetch(url+'/chat/completions', {
			body: JSON.stringify(params),
			signal: abort.signal,
			authorization
		}, chunk => {
			// 1. 获取 ID (第一个包逻辑)
			if (!proxyRequest) {
				const id = chunk.id;
				activeRequests.set(id, proxyRequest = {
					id,
					abort,
					data: completion,
					event: new EventEmitter,
					isFinished: false
				});

				ctx.res.writeHead(200, {
					'Content-Type': 'text/event-stream'
				});

				chunk.resumable = true;
			}

			if (!ctx.res.closed) ctx.res.write(`data: ${JSON.stringify(chunk)}\n\n`);

			proxyRequest.event.emit('data', chunk);

			const {choices, text} = chunk;
			if (choices) {
				let out_choices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++){
					const {delta, ...rest} = choices[i];
					if (!out_choices[i]) out_choices[i] = { delta: {} };

					Object.assign(out_choices[i], rest);
					applyDelta(out_choices[i].delta, delta);
				}
				delete chunk.choices;
			} else {
				completion.text = (completion.text || "") + text;
			}
			Object.assign(completion, chunk);

		}, () => {
			if (!proxyRequest && ctx.res.closed) {
				abort.abort();
				return true;
			}
		});
	} catch (err) {
		if (err.name === 'AbortError') {
			console.log('SSE代理请求中止');
		} else {
			console.log("SSE代理请求出错", err);

			const {code = 500, message} = err;
			let obj = {
				upstream_error: message
			};
			try {
				obj = JSON.parse(message);
			} catch {}

			ctx.send(code, obj);
		}
	} finally {
		if (proxyRequest) {
			proxyRequest.isFinished = true;
			proxyRequest.event.emit('end');
			proxyRequest.event.removeAllListeners();

			delete completion.resumable;
			//console.log('SSE代理请求结束');

			// 15分钟后销毁
			setTimeout(() => {
				activeRequests.delete(proxyRequest.id);
			}, 15 * 60 * 1000);
		}
		abort.abort();

		if (!ctx.res.closed) ctx.res.end();
	}
}

export function registerSSEProxyRoutes(router) {
	router.get('/models', async (ctx) => {
		let result = authorize(ctx);
		if (!result) return;
		const [url, authorization] = result;

		const proxyRes = await fetch(url+'/models', { headers: { authorization } });
		ctx.send(proxyRes.status, await proxyRes.json());
	});
	router.post('/chat/completions', SSEHandler);
	router.post('/completions', SSEHandler);

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
			activeRequests.delete(id);
			state.abort.abort(); // 停止向 OpenAI 请求
			return ctx.send(200, { success: true });
		}
		ctx.send(404, { success: false, error: "SSE代理会话已过期" });
	});
}