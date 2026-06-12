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
	RESPONSE_USE_MSGPACK_SCHEMA,
	RESTRICT_USER_CREATION,
	WEBSOCKET_SYNC_BASE,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";
import {c2s_schema_version} from "../common/MsgpackSchema.js";

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
export async function initServer(dataPath, basePath = "api", workspacePath) {
	const ROOT_DIR = path.resolve(dataPath);
	const workspace = path.resolve(workspacePath || ROOT_DIR+"/workspace");

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
	registerFsRoutes(router, true);
	router.pop();

	if (workspacePath) {
		router.pop();
		return router;
	}

	registerSSEProxy(router, ROOT_DIR);

	for await (const entry of fs.glob("plugins/*/index.js", { cwd: import.meta.dirname, withFileTypes: true })) {
		if (entry.isFile()) {
			(await import("file://"+path.join(entry.parentPath, entry.name))).default(router);
		}
	}

	router.push('v2/:userId');

	registerSSEProxy(router, ROOT_DIR);

	const batchTypes = {
		sync: (_, ctx) => WEBSOCKET_SYNC_ENABLE ? WEBSOCKET_SYNC_BASE(ctx) : null,
		version: () => [PROTOCOL_VERSION, RESPONSE_USE_MSGPACK_SCHEMA && c2s_schema_version]
	};

	// batch接口统一处理大部分请求
	router.post('/batch', async (ctx) => {
		const body = await ctx.readAsObject(4194304);
		const rejectors = ctx.variables;
		let out = [];
		const promises = [];
		for (const [type, value] of body) {
			let result;
			const handler = batchTypes[type];
			if (!handler) {
				result = { error: "unknown endpoint "+type };
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
						}));
					} else {
						result = resp;
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
		return ctx.send(200, out);
	});

	if (INTERACTIVE_LOGIN) {
		registerPairingRoutes(router);
	}

	registerMessageRoutes(batchTypes);
	registerKVRoutes(batchTypes);
	registerSearchRoutes(router);
	registerLogRoutes(router, batchTypes);
	registerDatabaseRoutes(router, ROOT_DIR);
	registerBlobRoutes(router, batchTypes, ROOT_DIR+'/blobs');

	router.pop();
	router.pop();

	return router;
}
