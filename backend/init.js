import path from 'node:path';
import fs from 'node:fs/promises';

import {Router} from "./router.js";
import {registerMessageRoutes} from "./routes/messages.js";
import {registerKVRoutes} from "./routes/kv.js";
import {registerSearchRoutes} from "./routes/search.js";
import {registerLogRoutes} from "./routes/log.js";
import {registerDatabaseRoutes} from "./routes/database.js";
import {registerFsRoutes} from "./routes/agent.js";
import {registerBlobRoutes} from "./routes/blob-storage.js";
import {registerSSEProxyRoutes} from "./routes/sse-proxy.js";

import {
	ALLOW_USER_NAMES,
	INTERACTIVE_LOGIN,
	RESTRICT_USER_CREATION,
	WEBSOCKET_SYNC_BASE,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";

import {compressGeneric, decompressGeneric, deserializeRow} from "./utils/compression.js";
import {loadUserData} from "./utils/UserManager.js";
import {PROTOCOL_VERSION} from "./sync_const.js";
import {checkPAT} from "./utils/PAT.js";
import {registerPairingRoutes} from "./routes/pairing.js";

global.compression = {
	compressGeneric,
	decompressGeneric,
	deserializeRow
};

/**
 * @param router {AiChatBackend.Router}
 * @param rootDir {string}
 */
const registerSSEProxy = (router, rootDir) => {
	router.get("/sse/props", (ctx) => {
		ctx.res.writeHead(204, {
			vary: "Authorization",
			"cache-control": "public"
		});
		ctx.res.end();
	});

	router.push("sse/v1");
	registerSSEProxyRoutes(router, rootDir);
	router.pop();
};

/**
 *
 * @param {string} dataPath
 * @param {string} basePath
 * @param {string=} workspacePath
 * @return {Promise<AiChatBackend.Router>}
 */
export async function createRouter(dataPath, basePath = "api", workspacePath) {
	const workspace = path.resolve(workspacePath || dataPath+"/workspace");

	/** @type {AiChatBackend.Router} */
	const router = new Router((ctx) => {
		const sandboxRoot = path.join(workspace, ctx.searchParams.get("root") || "")
		ctx.sandboxRoot = sandboxRoot;
		ctx.errorFilter = str => str.replaceAll(sandboxRoot, "");

		const {userId} = ctx.params;
		if (userId != null) {
			if (RESTRICT_USER_CREATION && !ALLOW_USER_NAMES.has(userId)) {
				ctx.send(403, { error: "no such user" });
				return true;
			}

			const getData = () => ctx._db || (ctx._db = loadUserData(dataPath, userId));

			Object.defineProperty(ctx, "db", {
				get: () => getData().sqlite,
			});
			Object.defineProperty(ctx, "vectorDB", {
				get: () => getData().vector,
			});

			if (INTERACTIVE_LOGIN) {
				const pat = (ctx.req.headers.authorization || '').slice("Bearer ".length);
				if (!pat) {
					if (!ctx.path.endsWith("/login") && !/\/blobs$|\/blob\/[a-zA-Z0-9_-]+$/.test(ctx.path)) {
						ctx.send(401, {error: "unauthorized"});
						return true;
					}
				} else {
					const valid = checkPAT(pat, ctx);
					if (!valid) {
						ctx.send(401, {error: "invalid token"});
						return true;
					}
				}
			}
		}
	});

	router.push(basePath);

	router.push("fs");
	await registerFsRoutes(router, workspacePath);
	router.pop();

	if (workspacePath) {
		router.pop();
		return router;
	}

	registerSSEProxy(router, dataPath);

	for await (const entry of fs.glob("plugins/*/index.js", { cwd: import.meta.dirname, withFileTypes: true })) {
		if (entry.isFile()) {
			(await import("file://"+path.join(entry.parentPath, entry.name))).default(router);
		}
	}

	router.push('v2/:userId');

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
			if (INTERACTIVE_LOGIN) queries.push("t="+encodeURIComponent(ctx.req.headers.authorization.slice(7)));
			return base+"?"+queries.join("&");
		},
		version: () => [PROTOCOL_VERSION]
	};

	/**
	 *
	 * @param {AiChatBackend.RouteContext} ctx
	 * @param {Array<[string, *]>} body
	 * @return {Promise<*[]>}
	 */
	async function handleBatch(ctx, body) {
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
					const resp = handler(value, ctx);
					let toReject = [...rejectors];
					rejectors.length = 0;

					if (resp instanceof Promise) {
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
					} else {
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
		return ctx.send(200, out);
	});

	if (INTERACTIVE_LOGIN) {
		registerPairingRoutes(router);
	}

	registerMessageRoutes(batchTypes);
	registerKVRoutes(batchTypes);
	registerSearchRoutes(router);
	registerLogRoutes(router, batchTypes);
	registerDatabaseRoutes(router, dataPath);
	registerBlobRoutes(router, batchTypes, dataPath+'/blobs');

	router.pop();
	router.pop();

	return router;
}
