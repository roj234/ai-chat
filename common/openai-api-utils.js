import {debugSymbol} from "unconscious/shared.js";
import {webviewFetch} from "/vendor/jsBridge.js";

/**
 * @param {Error} err
 */
const networkErrorHandler = (url, err) => {
	if (err.message === "Failed to fetch")
		throw ("网络连接失败\n请检查API地址是否正确，连接是否畅通\n"+url);
	throw err;
};

export const ORIGINAL_ERROR = debugSymbol("OriginalError");
const FETCH = IS_ANDROID_BUILD ? webviewFetch : fetch;

async function responseErrorHandler(res) {
	const func = res.headers.get('content-type')?.startsWith('application/json') ? 'json' : 'text';
	let obj = await res[func]();
	const init = obj;
	if (obj && typeof obj === 'object') {
		if (obj.error && Object.keys(obj).length === 1) {
			obj = obj.error;
		}
	}
	if (typeof obj !== 'string') obj = JSON.stringify(obj);
	throw {status: res.status, message: obj, [ORIGINAL_ERROR]: init};
}

/**
 * 发起JSON请求
 * @param {string} url
 * @param {string=} key
 * @param {RequestInit} data
 * @return {Promise<*>}
 */
export const jsonFetch = (url, {key = "", ...data} = {}) => FETCH(url, {
	method: data.body ? "POST" : "GET",
	referrerPolicy: 'no-referrer',
	...data,
	headers: {
		'Accept': 'application/json',
		...makeHeaders(data, key),
		...data.headers
	},
})
.catch(networkErrorHandler.bind(null, url))
.then(res => {
	if (!res.ok) {
		return responseErrorHandler(res).catch(err => {
			throw (`API错误 (${err.status})\n${err.message}`);
		});
	}

	return res.json();
});

const makeHeaders = (data, key) => {
	const headers = {};
	if (key) headers['Authorization'] = "Bearer "+key;
	if (data.body) headers['Content-Type'] = 'application/json';
	return headers;
}

/**
 * 发起流式请求
 * @param {string} url
 * @param {string=} key
 * @param {boolean=true} json
 * @param {RequestInit} data
 * @param {function(OpenAI.Response, string): void} onChunk
 * @return {Promise<Response>}
 */
export const sseFetch = (url, {key = "", json = true, ...data} = {}, onChunk) => FETCH(url, {
	method: "POST",
	referrerPolicy: 'no-referrer',
	...data,
	headers: {
		'Accept': 'application/json,text/event-stream',
		...makeHeaders(data, key),
		...data.headers
	},
})
.catch(networkErrorHandler.bind(null, url))
.then(async res => {
	if (!res.ok) return responseErrorHandler(res);

	const contentType = res.headers.get('content-type');
	if (contentType?.startsWith('application/json')) {
		onChunk(await res.json(), '\0');
		return res;
	}

	const reader = res.body.getReader();

	const decoder = new TextDecoder();
	const STREAM = {stream: true};
	let buf = '';

	try {
		let event;
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;

			buf += decoder.decode(value, STREAM);

			const lines = buf.split("\n");
			buf = lines.pop() || '';

			for (const line of lines) {
				if (line.startsWith('event: ')) event = line.slice(7);
				else if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') return;
					if (!data) continue;

					const obj = json ? JSON.parse(data) : data;
					if (null == obj) continue;

					let error = obj.error;
					try {
						onChunk(obj, event);
					} catch (e) {
						if (!error)
							error = e instanceof Error ? e.message : e;
					}

					if (error) throw { status: 'SSE Chunk', message: typeof error === 'string' ? error : JSON.stringify(error) };
					event = undefined;
				}/* else {
					if (line && !'event: '.startsWith(line) && !'data: '.startsWith(line)) {
						throw new Error("Illegal SSE response");
					}
				}*/
			}
		}
	} finally {
		await reader.cancel();
	}

	return res;
});


const neverAccumulate = new Set(["role", "model", "type", "format"]);
/**
 *
 * @param {Object} chunk
 * @param {Object} delta
 */
export const applyDelta = (chunk, delta) => {
	if (Array.isArray(delta)) {
		if (!chunk) chunk = [];

		for (const {index, ...item} of delta) {
			if (index == null) { chunk.push(item); continue; }
			chunk[index] = applyDelta(chunk[index], item);
		}
	} else if (typeof delta === "object") {
		if (!chunk) chunk = {};

		for (const key in delta) {
			const deltaVal = delta[key];
			if (deltaVal == null) continue;

			if (neverAccumulate.has(key)) chunk[key] = deltaVal;
			else chunk[key] = applyDelta(chunk[key], deltaVal);
		}
	} else if (typeof chunk === "string") {
		chunk += delta;
	} else {
		chunk = delta;
	}

	return chunk;
};

