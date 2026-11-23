import {msgpack_schema, msgpack_schema_version} from "/common/wire-compression-schema.js";
import {constants, createBrotliCompress, createGzip} from "node:zlib";
import {NO_CORS, RESPONSE_COMPRESS_LEVEL, RESPONSE_USE_MSGPACK_SCHEMA} from "./config.js";
import {decodeMsg, encodeRawMsg} from "@roj234/msgpack";
import {Router} from "@roj234/expresso";

export class HttpError extends Error {
	/**
	 * @param {number} statusCode
	 * @param {string} [message]
	 * @param {Record<string, string>} [headers]
	 */
	constructor(statusCode, message = '', headers) {
		super(message);
		this.status = statusCode;
		this.headers = headers;
	}
}

export class App {
	// 外部字段
	zipRouter;
	sync;

	// hook
	#filter;

	/** @type {string[]} prefix stack */
	#prefixes = [];
	#router = new Router();

	/**
	 * @param {function(AiChatBackend.RouteContext): boolean} filter
	 */
	constructor(filter) {this.#filter = filter;}

	push(path) { this.#prefixes.push(path); }
	pop()      { this.#prefixes.pop(); }

	get(path, handler)    { this.#add('GET', path, handler); }
	post(path, handler)   { this.#add('POST', path, handler); }
	put(path, handler)    { this.#add('PUT', path, handler); }
	delete(path, handler) { this.#add('DELETE', path, handler); }
	patch(path, handler)  { this.#add('PATCH', path, handler); }

	/**
	 * @param {string} method
	 * @param {string} path - vue-router compatible path format
	 * @param handler
	 */
	#add(method, path, handler) {
		const fullPath = this.#prefixes.join('/') + path;
		this.#router.add(method, fullPath, handler);
	}

	/**
	 * Main request handler. Walks the trie to find a matching route.
	 *
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @return {Promise<void>}
	 */
	async handle(req, res) {
		let url;
		try {
			url = new URL(req.url, `http://${req.headers.host}`);
		} catch {
			res.end();
			return;
		}

		const method = req.method;
		const inputHeaders = req.headers["access-control-request-headers"] || "Content-Type, Authorization, X-Ci, X-Pv, X-Sv";
		const path = url.pathname;
		// 谦让式协程就是爽啊，什么对象池都可以滚了
		const match = this.#router.find(method === 'HEAD' ? 'GET' : method, path);

		if (NO_CORS) {
			res.setHeader('Access-Control-Allow-Origin', '*');
			if (method === 'OPTIONS' && !match?.handler) {
				res.setHeader('Access-Control-Allow-Methods', (match?.allow?.join(', ') || 'GET')+", HEAD");
				res.setHeader('Access-Control-Allow-Headers', inputHeaders);
				res.setHeader("Vary", "access-control-request-headers, access-control-request-method");
				res.writeHead(204);
				res.end();
				return;
			}
		}

		if (match !== null) {
			const {params, handler} = match;

			if (!handler) {
				res.writeHead(405, { 'Allow': match.allow.join(', ')+", HEAD", });
				res.end();
				return;
			}

			const variables = new Map();
			const newVariables = [];
			let queryObj;

			/** @type {AiChatBackend.RouteContext} */
			const ctx = {
				url,
				path,
				req,
				res,
				params,
				get query(){return queryObj ??= Object.fromEntries(url.searchParams.entries())},
				searchParams: url.searchParams,
				getVariable: (name) => variables.get(name) || null,
				setVariable(name) {
					let _resolve, _reject;
					const get = new Promise((resolve, reject) => {
						_resolve = resolve;
						_reject = reject;
					});
					get.catch(() => {});

					variables.set(name, get);
					newVariables.push(_reject);
					return _resolve;
				},
				variables: newVariables,
				send(status, data) {
					if (res.headersSent) return;

					if (undefined === data || method === 'HEAD') {
						res.writeHead(status);
						res.end();
						return;
					}

					const {accept = '', ['x-sv']: x_msv} = req.headers;
					const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();

					let outputStream = res;
					let encoder, contentType;
					if (RESPONSE_USE_MSGPACK_SCHEMA && accept.includes('application/vnd.msgpack') && x_msv === msgpack_schema_version) {
						encoder = (data) => encodeRawMsg(data, (buf, shared) => {
							outputStream.write(shared ? Buffer.from(buf) : buf);
						}, {schema: msgpack_schema});
						contentType = 'application/vnd.msgpack';
					} else {
						encoder = (data) => outputStream.write(Buffer.from(JSON.stringify(data)));
						contentType = 'application/json';
					}

					let encoding;
					if (RESPONSE_COMPRESS_LEVEL && acceptEncoding.includes('br')) {
						const stream = createBrotliCompress({
							params: {
								[constants.BROTLI_PARAM_QUALITY]: RESPONSE_COMPRESS_LEVEL,
							}
						});
						stream.pipe(outputStream);
						outputStream = stream;
						encoding = 'br';
					} else if (acceptEncoding.includes('gzip')) {
						const stream = createGzip();
						stream.pipe(outputStream);
						outputStream = stream;
						encoding = 'gzip';
					}

					const headers = {
						'Content-Type': contentType,
						'Vary': 'Accept-Encoding',
					};
					if (encoding) headers['Content-Encoding'] = encoding;

					res.writeHead(status, headers);
					encoder(data);
					outputStream.end();
				},
				readAsBuffer: (maxLength = 1048576) => new Promise((resolve, reject) => {
					if (parseInt(req.headers['content-length']) > maxLength)
						throw new HttpError(413, 'Request body too large');

					let chunks = [];
					let totalLength = 0;
					req.on('data', chunk => {
						const length = chunk.length;
						if (totalLength + length > maxLength) {
							reject(new HttpError(413, 'Request body too large'));
							return;
						}
						totalLength += length;
						chunks.push(Buffer.from(chunk));
					});
					req.on('end', () => resolve(Buffer.concat(chunks)));
					req.on('error', reject);
				}),
				readAsString: (maxLength) => ctx.readAsBuffer(maxLength).then(String),
				readAsObject: async (maxLength) => {
					const type = ctx.req.headers['content-type'];
					const buffer = await ctx.readAsBuffer(maxLength);
					if (type === 'application/json') {
						return JSON.parse(buffer.toString());
					}
					if (type === 'application/vnd.msgpack') {
						return decodeMsg(buffer, { schema: msgpack_schema });
					}
					throw new HttpError(400, 'unsupported content-type');
				},
			};

			let filter = this.#filter;

			try {
				if (typeof filter === 'function' && filter(ctx)) return;

				await handler(ctx);
			} catch (err) {
				console.error(err);
				if (res.headersSent) return res.end();

				let msg = err.message ?? err;
				if (ctx.errorFilter) msg = ctx.errorFilter(msg, err);
				try {
					if ((req.headers.accept || '') .includes('application/json')) {
						ctx.send(err.status || 500, { error: err.code != null ? { ...err, message: msg, __type: 'Error' } : msg });
					} else {
						res.writeHead(err.status || 500, { 'Content-Type': 'text/plain;charset=utf-8', ...err.headers });
						res.end(msg);
					}
				} catch {}
			}

			return;
		}

		if (method !== 'GET' && method !== 'HEAD') {
			res.writeHead(405, { 'Allow': 'GET, HEAD', });
			res.end();
			return;
		}

		if (this.zipRouter) {
			try {
				const handled = await this.zipRouter({
					path: path,
					req,
					res,
				});
				if (handled) return;
			} catch (err) {
				console.error(err);
				req.end();
				return;
			}
		}

		res.writeHead(404);
		res.end();
	}
}
