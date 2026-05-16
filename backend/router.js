import {URL} from 'node:url';
import {c2s_schema, s2c_schema, s2c_schema_version} from "../common/MsgpackSchema.js";
import {constants, createBrotliCompress, createGzip} from "node:zlib";
import {RESPONSE_COMPRESS_LEVEL} from "./config.js";
import {decodeMsg, encodeRawMsg} from "unconscious/common/msgpack.js";

export class Router {
	/**
	 * @param init {function(AiChatBackend.RouteContext): boolean}
	 */
	constructor(init) {
		this.init = init;
		this.zipRouter = null;
		this.routes = [];
		this.prefixes = [];
	}

	push(path) {this.prefixes.push(path);}
	pop() {this.prefixes.pop();}

	get(path, handler)    { this._add('GET', path, handler); }
	post(path, handler)   { this._add('POST', path, handler); }
	put(path, handler)    { this._add('PUT', path, handler); }
	delete(path, handler) { this._add('DELETE', path, handler); }

	_add(method, path, handler) {
		const paramNames = [];
		const regexStr = (this.prefixes.join("/")+path).replace(/:(\w+)/g, (_, name) => {
			paramNames.push(name);
			return '([^/]+)';
		}) + '/?$';
		const regex = new RegExp('^' + regexStr);
		this.routes.push({ method, regex, paramNames, handler });
	}

	/**
	 *
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @return {Promise<void>}
	 */
	async handle(req, res) {
		let parsedUrl;
		try {
			parsedUrl = new URL(req.url, `http://${req.headers.host}`);
		} catch {
			res.end();
			return;
		}

		const urlPath = parsedUrl.pathname.slice(1) || '/';
		const method = req.method.toUpperCase();

		// CORS headers
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-schema-version');

		if (method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		// Find matching route
		for (const route of this.routes) {
			if (route.method !== method) continue;
			const match = urlPath.match(route.regex);
			if (!match) continue;

			const params = {};
			route.paramNames.forEach((name, i) => {
				params[name] = decodeURIComponent(match[i + 1]);
			});

			const variables = new Map;
			const newVariables = [];

			/** @type {AiChatBackend.RouteContext} */
			const ctx = {
				url: parsedUrl,
				path: urlPath,
				req,
				res,
				params,
				query: Object.fromEntries(parsedUrl.searchParams.entries()),
				searchParams: parsedUrl.searchParams,
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
					const {accept = "", ["x-schema-version"]: x_msv} = req.headers;
					const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();

					let outputStream = res;
					let encoder, contentType;
					if (accept.includes('application/vnd.msgpack') && x_msv === s2c_schema_version) {
						encoder = (data) => encodeRawMsg(data, (buf, shared) => {
							outputStream.write(shared ? Buffer.from(buf) : buf);
						}, s2c_schema);
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

					// 3. 准备响应头（先不含 Content-Encoding）
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
					let chunks = [];
					let totalLength = 0;
					req.on('data', chunk => {
						const length = chunk.length;
						if (totalLength + length > maxLength) {
							reject(new Error("Request body too large"));
							return;
						}
						totalLength += length;
						chunks.push(Buffer.from(chunk));
					});
					req.on('end', () => resolve(Buffer.concat(chunks)));
					req.on('error', reject);
				}),
				readAsString: (maxLength) => ctx.readAsBuffer(maxLength).then(String),
				readAsObject: async () => {
					const type = ctx.req.headers["content-type"];
					const buffer = await ctx.readAsBuffer();
					if (type === "application/json") {
						return JSON.parse(buffer.toString());
					}
					if (type === "application/vnd.msgpack") {
						return decodeMsg(buffer, { schema: c2s_schema });
					}
					throw new Error("unknown content-type");
				},
			};

			let init = this.init;
			if (typeof init === "function" && init(ctx)) {
				return;
			}

			try {
				await route.handler(ctx);
			} catch (err) {
				console.error(err);

				let msg = err.message;
				if (ctx.errorFilter) msg = ctx.errorFilter(msg, err);
				try {
					ctx.send(500, { error: msg });
				} catch {}
			}
			return;
		}

		if (this.zipRouter) {
			try {
				const ok = await this.zipRouter({
					path: urlPath,
					req,
					res,
				});
				if (ok) return;
			} catch (err) {
				console.error(err);
				res.end();
				return;
			}
		}

		// 404
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not Found' }));
	}
}