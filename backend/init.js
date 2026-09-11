import path from 'node:path';
import fs from 'node:fs/promises';

import {Router} from "./router.js";
import {registerMessageRoutes} from "./routes/messages.js";
import {registerKVRoutes} from "./routes/kv.js";
import {registerSearchRoutes} from "./routes/search.js";
import {registerLogRoutes} from "./routes/log.js";
import {registerDatabaseRoutes} from "./routes/database.js";
import {registerFsRoutes} from "./routes/agent.js";
import {BLOB_HASH_REGEX, registerBlobRoutes} from "./routes/blob-storage.js";
import {registerVectorDBRoutes} from "./routes/vectordb.js";
import {proxyHandler, registerSSEProxyRoutes} from "./routes/sse-proxy.js";

import {
	ALLOW_USER_NAMES,
	FS_SERVICE_PAT,
	INTERACTIVE_LOGIN,
	MAX_UPLOAD_SIZE,
	RESTRICT_USER_CREATION,
	WEBSOCKET_SYNC_BASE,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";

import {loadUserData} from "./utils/UserManager.js";
import {PROTOCOL_VERSION} from "./sync.js";
import {checkPAT, generatePAT} from "./utils/PAT.js";
import {registerPairingRoutes} from "./routes/pairing.js";

// Export plugin APIs to globalThis
import "./pluginApi.js";

/**
 * @param router {AiChatBackend.Router}
 * @param rootDir {string}
 */
const registerSSEProxy = (router, rootDir) => {
	for (const endpoint of ['props', 'models/load', 'models/unload']) {
		const handler = proxyHandler.bind(null, endpoint);
		router.get("/sse/"+endpoint, handler);
		router.post("/sse/"+endpoint, handler);
	}

	router.push("sse/v1");
	registerSSEProxyRoutes(router, rootDir);
	router.pop();
};

/**
 *
 * @param {string} dataPath
 * @param {string} apiPath
 * @param {string=} workspacePath
 * @return {Promise<AiChatBackend.Router>}
 */
export async function createRouter(dataPath, apiPath = "api", workspacePath) {
	const workspace = path.resolve(workspacePath || dataPath+"/workspace");

	/** @type {AiChatBackend.Router} */
	const router = new Router( (ctx) => {
		let fsRoot;

		const {userId} = ctx.params;
		if (userId != null) {
			if (RESTRICT_USER_CREATION ? !ALLOW_USER_NAMES.has(userId) : /[\s\\/:*?<>|]/.test(userId)) {
				ctx.send(403, { error: "userId is not allowed" });
				return true;
			}

			const urlPath = ctx.path;
			const method = ctx.req.method;
			if (/\/sse\/v1\//.test(urlPath)) return;

			ignorePAT:
			if (INTERACTIVE_LOGIN) {
				if (urlPath.endsWith('/login') && method === 'POST') break ignorePAT;

				const pat = (ctx.req.headers.authorization || '').slice("Bearer ".length);
				if (!pat) {
					if (new RegExp("/blob/"+BLOB_HASH_REGEX+"$").test(urlPath) && method === 'GET') {
						break ignorePAT;
					}

					ctx.send(401, {error: "unauthorized"});
					return true;
				} else {
					loadUserData(dataPath, userId, ctx);
					const valid = checkPAT(pat, ctx);
					if (!valid) {
						ctx.send(401, {error: "invalid token"});
						return true;
					}
				}
			}

			fsRoot = path.join(workspace, userId);
		} else {
			const pat = (ctx.req.headers.authorization || '').slice("Bearer ".length);
			if (pat !== FS_SERVICE_PAT) {
				ctx.send(401, {error: "invalid token"});
				return true;
			}

			fsRoot = workspace;
		}

		const relativePath = ctx.searchParams.get("root");
		if (relativePath) {
			const targetPath = path.resolve(fsRoot, relativePath);
			if (!targetPath.startsWith(fsRoot + path.sep)) {
				ctx.send(403, {error: "Path Traversal"});
				return true;
			}

			fsRoot = targetPath;
		}

		ctx.errorFilter = str => str.replaceAll(fsRoot, "");
		ctx.fsRoot = fsRoot + path.sep;
	});

	router.push(apiPath);

	for await (const entry of fs.glob("plugins/*/index.js", { cwd: import.meta.dirname, withFileTypes: true })) {
		if (entry.isFile()) {
			try {
				await (await import("file://"+path.join(entry.parentPath, entry.name))).default(router, workspace);
				console.info("Loaded plugin "+path.basename(entry.parentPath));
			} catch (e) {
				console.error("Failed to load plugin "+path.basename(entry.parentPath));
				console.error(e);
			}
		}
	}

	if (workspacePath) {
		router.push("fs");
		await registerFsRoutes(router, workspacePath);
		router.pop();

		router.pop();
		return router;
	}

	registerSSEProxy(router, dataPath);

	router.push('v2/:userId');

	router.push("fs");
	await registerFsRoutes(router, workspacePath);
	router.pop();

	registerSSEProxy(router, dataPath);

	const batchTypes = {
		/**
		 * @param {AiChatBackend.RouteContext} ctx
		 */
		sync: (_, ctx) => {
			if (!WEBSOCKET_SYNC_ENABLE) return null;
			const base = WEBSOCKET_SYNC_BASE(ctx);
			const queries = [];

			const userId = ctx.params.userId;
			if (userId) queries.push("u="+encodeURIComponent(userId));
			if (INTERACTIVE_LOGIN) queries.push("t="+generatePAT(ctx, {
				capabilities: 2,
				validUntil: Math.trunc(Date.now() / 1000) + 300
			}));
			return base+"?"+queries.join("&");
		},
		version: () => [PROTOCOL_VERSION, MAX_UPLOAD_SIZE]
	};

	/**
	 *
	 * @param {AiChatBackend.RouteContext} ctx
	 * @param {Array<[string, *]>} body
	 * @return {Promise<*[]>}
	 */
	async function handleBatch(ctx, body) {
		if (!Array.isArray(body) || !body.every(item => Array.isArray(item) && item.length === 2)) {
			ctx.send(500, { error: "invalid body" });
			return;
		}

		const rejectors = ctx.variables;
		const sync = router.sync;
		let out = [];
		const promises = [];
		for (const [func, value] of body) {
			let result;
			const handler = batchTypes[func];
			if (!handler) {
				result = { error: "unknown function "+func };
			} else {
				try {
					const resp = await handler(value, ctx);
					//let toReject = [...rejectors];
					rejectors.length = 0;

					/*if (resp instanceof Promise) {
						const size = out.length;
						promises.push(resp.catch(e => {
							toReject.forEach(reject => reject(e));
							console.error(e);
							return { error: e.message };
						}).then(result => {
							toReject.forEach(reject => reject("No value specified"));
							out[size] = result;
							sync?.onBatch(ctx, func, value, result);
						}));
					} else */{
						result = resp;
						sync?.onBatch(ctx, func, value, result);
					}
				} catch (e) {
					rejectors.forEach(reject => reject(e));
					rejectors.length = 0;

					console.error(e);
					result = { error: e.message };
				}
			}
			out.push(result);
		}

		await Promise.all(promises);
		return out;
	}

	router.post('/batch', async (ctx) => {
		const body = await ctx.readAsObject(4194304);
		const out = await handleBatch(ctx, body);
		if (out) ctx.send(200, out);
	});

	if (INTERACTIVE_LOGIN) {
		registerPairingRoutes(router, dataPath);
	} else {
		router.post('/login', (ctx) => {
			ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			ctx.res.end(`data: {"skip":1}\n\ndata: [DONE]\n\n`);
		});
	}

	registerMessageRoutes(batchTypes);
	registerKVRoutes(batchTypes);
	registerSearchRoutes(router);
	registerLogRoutes(router, batchTypes);
	registerDatabaseRoutes(router, dataPath);
	registerBlobRoutes(router, batchTypes, dataPath+'/blobs');
	registerVectorDBRoutes(router, dataPath);

	router.pop();
	router.pop();

	return router;
}
