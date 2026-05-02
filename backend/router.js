import {URL} from 'node:url';
import {createZipRouter} from "./utils/zipRouter.js";

export class Router {
	constructor(init, zip) {
		this.init = init;
		if (zip) {
			createZipRouter(zip).then(fn => {
				this.zipRouter = fn;
			})
		}
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

	async handle(req, res) {
		let parsedUrl;
		try {
			parsedUrl = new URL(req.url, `http://${req.headers.host}`);
		} catch {
			res.end();
			return;
		}

		const urlPath = parsedUrl.pathname.substring(1) || '/';
		const method = req.method.toUpperCase();

		// CORS headers
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
				params[name] = match[i + 1];
			});

			/** @type {AIChatBackend.RouteContext} */
			const ctx = {
				url: parsedUrl,
				path: urlPath,
				req,
				res,
				params,
				query: Object.fromEntries(parsedUrl.searchParams.entries()),
				send: (status, data) => {
					res.writeHead(status, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(data));
				},
				readBody: () => new Promise((resolve, reject) => {
					let body = '';
					req.on('data', chunk => body += chunk);
					req.on('end', () => {
						try { resolve(body ? JSON.parse(body) : {}); }
						catch { reject(new Error('Invalid JSON')); }
					});
				})
			};

			let init = this.init;
			if (typeof init === "function") init(ctx);

			try {
				const p = route.handler(ctx);
				if (p instanceof Promise) await p;
				return;
			} catch (err) {
				console.error(err);
				ctx.send(500, { error: err.message });
				return;
			}
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