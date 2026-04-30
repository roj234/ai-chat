import {DatabaseSync} from 'node:sqlite';
import {Router} from "./router.js";
import {registerConversationRoutes} from "./routes/conversation.js";
import {registerMessageRoutes} from "./routes/messages.js";
import {registerKvRoutes} from "./routes/kv.js";
import {registerKvsRoutes} from "./routes/kvs.js";
import {registerSearchRoutes} from "./routes/search.js";
import {registerBillingRoutes} from "./routes/log.js";
import {registerDatabaseRoutes} from "./routes/database.js";
import {registerFsRoutes} from "./routes/fs.js";
import {registerFsExecRoutes} from "./routes/fs-exec.js";
import {registerBlobRoutes} from "./routes/blob-storage.js";

import path from 'node:path';
import {VectorDB} from "./rag/VectorDB.js";
import {SEMANTIC_SEARCH_ENABLE, WEBSOCKET_SYNC_ENABLE} from "./config.js";


export function initServer(dataPath, basePath = "aichat/v2") {
	const ROOT_DIR = path.resolve(dataPath);
	const workspace = path.resolve(ROOT_DIR+"/workspace");

	const router = new Router((ctx) => {
		ctx.sandboxRoot = workspace;
		const userId = ctx.params.userId;
		if (userId) {
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

	router.push(':userId');

	router.get("props", ctx => {
		ctx.send(200, {
			version: 2,
			sync: WEBSOCKET_SYNC_ENABLE ? "ws://"+ctx.req.headers.host+"/aichat/v2/sync?user="+encodeURIComponent(ctx.params.userId) : null,
		});
	});

	registerConversationRoutes(router);
	registerMessageRoutes(router);
	registerKvRoutes(router);
	registerKvsRoutes(router);
	registerSearchRoutes(router);
	registerBillingRoutes(router);
	registerDatabaseRoutes(router);
	registerBlobRoutes(router, ROOT_DIR+'/blobs');

	router.pop();
	router.push("fs");

	registerFsRoutes(router);
	registerFsExecRoutes(router);

	router.pop();
	router.pop();

	return router;
}

// dbManager.js 增加清理
const MAX_CONNECTIONS = 4;
const connections = new Map();
const usageTimestamps = new Map();

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
		if (oldestUser) {
			const {sqlite, vector} = connections.get(oldestUser);
			sqlite.close();
			vector.save();
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
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS kvs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner);
    CREATE INDEX IF NOT EXISTS idx_kvs_type_name ON kvs(type, name);
    CREATE TABLE IF NOT EXISTS statistics (
      message_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
	return db;
}