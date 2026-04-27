import {DatabaseSync} from 'node:sqlite';
import {Router} from "./router.js";
import {registerMessageRoutes} from "./routes/messages.js";
import {registerKVRoutes} from "./routes/kv.js";
import {registerSearchRoutes} from "./routes/search.js";
import {registerLogRoutes} from "./routes/log.js";
import {registerDatabaseRoutes} from "./routes/database.js";
import {registerFsRoutes} from "./routes/fs.js";
import {registerBlobRoutes} from "./routes/blob-storage.js";

import path from 'node:path';
import {VectorDB} from "./rag/VectorDB.js";
import {
	ALLOW_USER_NAMES,
	RESTRICT_USER_CREATION,
	SEMANTIC_SEARCH_ENABLE,
	SHUTDOWN_SQL,
	STARTUP_SQL,
	WEBSOCKET_SYNC_BASE,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";
import {registerSSEProxyRoutes} from "./routes/sse-proxy.js";


export function initServer(dataPath, basePath = "aichat/v2", zipBlob) {
	const ROOT_DIR = path.resolve(dataPath);
	const workspace = path.resolve(ROOT_DIR+"/workspace");

	const router = new Router((ctx) => {
		ctx.sandboxRoot = workspace;
		const userId = ctx.params.userId;
		if (RESTRICT_USER_CREATION && !ALLOW_USER_NAMES.has(userId)) {
			ctx.send(403, { error: "no such user" });
			return true;
		}

		if (userId) {
			const getData = () => ctx._db || (ctx._db = getUserData(dataPath, userId));

			Object.defineProperty(ctx, "db", {
				get: () => getData().sqlite,
			});
			Object.defineProperty(ctx, "vectorDB", {
				get: () => getData().vector,
			});
		}
	}, zipBlob);

	router.push(basePath);

	router.push("sse/v1");
	registerSSEProxyRoutes(router);
	router.pop();

	router.push("fs");
	registerFsRoutes(router, true);
	router.pop();

	router.push(':userId');

	router.get("/props", ctx => {
		ctx.send(200, {
			version: 2,
			sync: WEBSOCKET_SYNC_ENABLE ? WEBSOCKET_SYNC_BASE(ctx) : undefined,
		});
	});

	registerMessageRoutes(router);
	registerKVRoutes(router);
	registerSearchRoutes(router);
	registerLogRoutes(router);
	registerDatabaseRoutes(router);
	registerBlobRoutes(router, ROOT_DIR+'/blobs');

	router.pop();
	router.pop();

	return router;
}

// dbManager.js 增加清理
const MAX_CONNECTIONS = 4;
const connections = new Map();
const usageTimestamps = new Map();

function closeConnection(value) {
	const {sqlite, vector} = value;

	sqlite.exec(SHUTDOWN_SQL);
	sqlite.close();
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

function initDB(dbPath) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT DEFAULT '',
	time INTEGER NOT NULL,
	data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner INTEGER NOT NULL,
	time INTEGER,
	content TEXT NOT NULL,
	data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
	key TEXT PRIMARY KEY,
	value BLOB NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kvs (
	type TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (type, name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner);
CREATE TABLE IF NOT EXISTS statistics (
	message_id INTEGER PRIMARY KEY,
	time INTEGER NOT NULL,
	data BLOB NOT NULL
);
`);
	db.exec(STARTUP_SQL);
	return db;
}