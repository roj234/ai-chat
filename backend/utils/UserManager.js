// dbManager.js 增加清理
import {ENABLE_FILE_TRANSFER, SEMANTIC_SEARCH_ENABLE, SHUTDOWN_SQL, STARTUP_SQL} from "../config.js";
import {VectorDB} from "../rag/VectorDB.js";
import {DatabaseSync} from "node:sqlite";
import {cachePreparedSql} from "./sqliteUtils.js";
import {compressMessage} from "./compression.js";

const MAX_PARALLEL_CONNECTIONS = 4;
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

/**
 *
 * @param {string} dbPath
 * @param {string} userId
 * @return {any}
 */
export function loadUserData(dbPath, userId) {
	usageTimestamps.set(userId, Date.now());

	// 如果连接数超限，关闭最久未使用的
	if (usageTimestamps.size > MAX_PARALLEL_CONNECTIONS) {
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
const DB_VERSION = 2;

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
CREATE INDEX idx_conversations_time ON conversations(time);
CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner INTEGER NOT NULL REFERENCES conversations(id),
	time INTEGER,
	content TEXT NOT NULL,
	data BLOB NOT NULL
);
CREATE INDEX idx_messages_owner ON messages(owner);
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
CREATE TABLE logs (
	id INTEGER UNIQUE,
	time INTEGER NOT NULL,
	data BLOB NOT NULL
);

PRAGMA user_version = `+DB_VERSION); // logs 使用 rowid 做底层索引
	} else if (user_version < DB_VERSION) {
		if (user_version <= 1) {
			db.exec(`CREATE INDEX idx_conversations_time ON conversations(time)`);
		}
		db.exec(`PRAGMA user_version = `+DB_VERSION);
	}

	db.exec(STARTUP_SQL);
	if (ENABLE_FILE_TRANSFER) {
		db.prepare("INSERT INTO conversations (id, title, time, data) VALUES (0, '文件传输助手', ?, ?) ON CONFLICT(id) DO NOTHING").run(
			Date.now(), compressMessage({ noAI: true })
		);
	}
	return db;
}