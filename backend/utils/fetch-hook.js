import http from 'node:http';
import https from 'node:https';
import {Readable} from "node:stream";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Encode the request body into a Buffer.
 * Returns { buffer, contentType } or null.
 */
const encodeBody = body => {
	if (Buffer.isBuffer(body)) return [ body, 'application/octet-stream' ];

	if (body instanceof Uint8Array) return [ Buffer.from(body), 'application/octet-stream' ];

	return [
		Buffer.from(String(body), 'utf-8'),
		body instanceof URLSearchParams ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'text/plain;charset=UTF-8'
	];
};

/** Duck-type check: Node.js Readable stream (has .pipe) */
const isNodeStream = body => typeof body?.pipe === 'function';

/**
 * @param {URL} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
function makeRequest(url, { method, headers: headersInit, body, signal, agent, ...rest }) {
	const transport = url.protocol === 'https:' ? https : http;
	const headers = Object.create(null);

	if (headersInit) {
		if (headersInit[Symbol.iterator]) {
			for (const [k, v] of headersInit) headers[k.toLowerCase()] = v;
		} else {
			for (const [k, v] of Object.entries(headersInit)) headers[k.toLowerCase()] = v;
		}
	}
	if (!headers['host']) headers['host'] = url.host;

	let bodyBuffer, bodyStream;
	if (body != null) {
		if (body instanceof ReadableStream) {
			body = Readable.fromWeb(body);
		}
		if (isNodeStream(body)) {
			bodyStream = body;
		} else {
			const [buffer, contentType] = encodeBody(body);
			bodyBuffer = buffer;
			if (!headers['content-type']) headers['content-type'] = contentType;
			headers['content-length'] = String(bodyBuffer.byteLength);
		}
	}

	const options = {
		method,
		hostname: url.hostname,
		port: url.port || (url.protocol === 'https:' ? 443 : 80),
		path: url.pathname + url.search,
		headers,
		rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
		...rest
	};

	if (agent != null) options.agent = typeof agent === 'function' ? agent(url) : agent;

	return new Promise((resolve, reject) => {
		const req = transport.request(options, (res) => {
			const stream = new ReadableStream({
				start(controller) {
					res.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
					res.on('end', () => controller.close());
					res.on('error', (err) => controller.error(err));
				},
				cancel: () => res.destroy(),
			});

			const resHeaders = new Headers();
			for (const [k, v] of Object.entries(res.headers)) {
				if (Array.isArray(v)) {
					for (const item of v) resHeaders.append(k, item);
				} else {
					resHeaders.append(k, v);
				}
			}

			const response = new Response(stream, {
				status: res.statusCode,
				statusText: res.statusMessage,
				headers: resHeaders,
			});

			// Patch readonly properties
			Object.defineProperty(response, 'url', {
				get: () => url.href,
				configurable: true,
				enumerable: true,
			});
			Object.defineProperty(response, 'redirected', {
				get: () => false,
				configurable: true,
				enumerable: true,
			});
			Object.defineProperty(response, 'type', {
				get: () => 'basic',
				configurable: true,
				enumerable: true,
			});

			resolve(response);
		});

		req.on('error', reject);

		if (bodyStream) {
			bodyStream.pipe(req);
			bodyStream.on('error', (err) => req.destroy(err));
		} else {
			if (bodyBuffer) req.end(bodyBuffer);
			else req.end();
		}

		if (signal) {
			const onAbort = () => req.destroy(new DOMException('The operation was aborted', 'AbortError'));
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
			req.on('close', () => signal.removeEventListener('abort', onAbort));
		}
	});
}

/**
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function _fetch(input, {
	method = 'GET',
	headers,
	body,
	signal,
	redirect = 'follow',
	maxRedirects = 20, // unofficial
	...rest
} = {}) {
	let url;

	if (typeof input === 'string') {
		url = new URL(input);
	} else if (input instanceof URL) {
		url = new URL(input.href);
	} else if (input && typeof input === 'object' && 'url' in input) {
		url = new URL(input.url);
		method ??= input.method;
		headers ??= input.headers;
		body ??= input.body;
		redirect ??= input.redirect;
		signal ??= input.signal;
	} else {
		throw new TypeError('Invalid fetch input');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new TypeError(`Unsupported protocol: ${url.protocol}`);

	const init = {
		method: method.toUpperCase(),
		headers,
		body,
		signal,
		...rest // agent
	};

	let response = await makeRequest(url, init);

	if (redirect === 'follow') {
		let redirectCount = 0;
		const _maxRedirects = parseInt(maxRedirects);

		while (
			REDIRECT_STATUSES.has(response.status) &&
			redirectCount < _maxRedirects
		) {
			const location = response.headers.get('location');
			if (!location) break;

			url = new URL(location, url);

			// 301/302/303 → GET, drop body; 307/308 → keep method & body
			if (response.status !== 307 && response.status !== 308) {
				init.method = 'GET';
				delete init.body;
			}

			await response.body?.cancel();

			redirectCount++;
			response = await makeRequest(url, init);
			Object.defineProperty(response, 'redirected', {
				get: () => true,
				configurable: true,
				enumerable: true,
			});
		}
	} else if (redirect === 'error') {
		if (REDIRECT_STATUSES.has(response.status)) {
			throw new TypeError('Redirect not allowed');
		}
	}

	return response;
}

const origFetch = globalThis.fetch;
globalThis.fetch = _fetch;

export { _fetch as fetch, origFetch };
