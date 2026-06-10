import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs/promises';

import {Router} from "./router.js";
import {VectorDB} from "./rag/VectorDB.js";
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
	ENABLE_FILE_TRANSFER,
	RESPONSE_USE_MSGPACK_SCHEMA,
	RESTRICT_USER_CREATION,
	SEMANTIC_SEARCH_ENABLE,
	SHUTDOWN_SQL,
	STARTUP_SQL,
	WEBSOCKET_SYNC_BASE,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";
import {c2s_schema_version} from "../common/MsgpackSchema.js";

import {compressGeneric, compressMessage, decompressGeneric, deserializeRow} from "./utils/compression.js";
import {cachePreparedSql} from "./utils/sqliteUtils.js";

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

			const getData = () => ctx._db || (ctx._db = getUserData(dataPath, userId));

			Object.defineProperty(ctx, "db", {
				get: () => getData().sqlite,
			});
			Object.defineProperty(ctx, "vectorDB", {
				get: () => getData().vector,
			});
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
		msgpack: () => RESPONSE_USE_MSGPACK_SCHEMA && c2s_schema_version
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

// dbManager.js 增加清理
const MAX_CONNECTIONS = 4;
const connections = new Map();
const usageTimestamps = new Map();

/**
 *
 * @param {DatabaseSync} sqlite
 * @param {AiChatBackend.VectorDB} vector
 */
function closeConnection({sqlite, vector}) {
	sqlite.exec(SHUTDOWN_SQL);
	sqlite.close();

	vector?.close();
}

export function closeAllConnections() {
	for (const value of connections.values()) {
		closeConnection(value);
	}
}

function getUserData(dbPath, userId) {
	usageTimestamps.set(userId, Date.now());

	// 如果连接数超限，关闭最久未使用的
	if (usageTimestamps.size > MAX_CONNECTIONS) {
		let oldestUser = null, oldestTime = Infinity;
		for (let [id, time] of usageTimestamps) {
			if (time < oldestTime) {
				oldestTime = time;
				oldestUser = id;
			}
		}
		if (oldestUser && Date.now() - oldestTime > 5000) {
			closeConnection(connections.get(oldestUser));
			connections.delete(oldestUser);
			usageTimestamps.delete(oldestUser);
		}
	}

	let db = connections.get(userId);
	if (!db) connections.set(userId, db = {
		sqlite: initDB(dbPath ? dbPath+"/"+userId+".db" : ":memory:"),
		vector: dbPath && SEMANTIC_SEARCH_ENABLE ? new VectorDB(dbPath+"/"+userId+"_rag.db") : null
	});
	return db;
}

// 数据库版本号
const DB_VERSION = 1;

function initDB(dbPath) {
	const db = new DatabaseSync(dbPath);
	const { user_version } = db.prepare('PRAGMA user_version').get();
	cachePreparedSql(db);

	if (user_version === 0) {
		db.exec(`
CREATE TABLE conversations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT DEFAULT '',
	time INTEGER NOT NULL,
	data BLOB NOT NULL
);
CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner INTEGER NOT NULL REFERENCES conversations(id),
	time INTEGER,
	content TEXT NOT NULL,
	data BLOB NOT NULL
);
CREATE TABLE kv (
	key TEXT PRIMARY KEY,
	value BLOB NOT NULL
) WITHOUT ROWID;
CREATE TABLE kvs (
	type TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (type, name)
) WITHOUT ROWID;
CREATE INDEX idx_messages_owner ON messages(owner);
CREATE TABLE logs (
	id INTEGER UNIQUE,
	time INTEGER NOT NULL,
	data BLOB NOT NULL
);

PRAGMA user_version = `+DB_VERSION); // logs 使用 rowid 做底层索引
	} else if (user_version === DB_VERSION) {
	} else {
		throw new Error("数据库版本号错误，请补充迁移函数");
	}

	db.exec(STARTUP_SQL);
	if (ENABLE_FILE_TRANSFER) {
		db.prepare("INSERT INTO conversations (id, title, time, data) VALUES (0, '文件传输助手', ?, ?) ON CONFLICT(id) DO NOTHING").run(
			Date.now(), compressMessage({ noAI: true })
		);
	}
	return db;
}