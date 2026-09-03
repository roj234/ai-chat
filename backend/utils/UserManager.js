import {ENABLE_FILE_TRANSFER, MAX_OPEN_DATABASES, SEMANTIC_SEARCH_ENABLE, STARTUP_SQL} from "../config.js";
import {VectorDB} from "../rag/VectorDB.js";
import {DatabaseSync} from "node:sqlite";
import {cachePreparedSql} from "./sqliteUtils.js";
import {compressLog, compressMessage, decompressLog} from "./compression.js";
import {NULL_OWNER, TSDB} from "../tsdb/index.js";
import {LRUCache} from "../../common/LRUCache.js";

/** @type {LRUCache<string, { close: Function }>} */
let databases;

const closeConnection = async (v) => {
	try {
		await (await v).close();
	} catch (e) {
		console.error("Database close error", e);
	}
};

export const closeAllConnections = () => databases && Promise.all([...databases.values()].map(closeConnection));

/**
 *
 * @param {Object} obj
 * @param {string | symbol} key
 * @param {Function} fn
 */
function _once(obj, key, cacheKey, fn) {
	Object.defineProperty(obj, key, {
		get: () => {
			let value = databases.get(cacheKey);
			if (!value) databases.set(cacheKey, value = fn());
			Object.defineProperty(obj, key, { value, configurable: true });
			if (value instanceof Promise) {
				value.then(value => {
					Object.defineProperty(obj, key, { value, configurable: true });
				});
			}
			return value;
		},
		configurable: true
	})
}

/**
 *
 * @param {string} dbPath
 * @param {string} userId
 * @param {AiChatBackend.RouteContext} ctx
 */
export function loadUserData(dbPath, userId, ctx) {
	if (databases?.capacity !== MAX_OPEN_DATABASES) {
		databases?.clear();
		databases = new LRUCache(MAX_OPEN_DATABASES, closeConnection);
	}

	if (dbPath && SEMANTIC_SEARCH_ENABLE) {
		_once(ctx, 'vectorDB', userId+":vectorDB", () => {
			return new VectorDB(dbPath+"/"+userId+"_rag.db");
		});
	}
	if (dbPath) {
		_once(ctx, 'logDB', userId+":logDB", () => {
			return TSDB.create(dbPath+"/"+userId+"-log");
		});
	}

	_once(ctx, 'db', userId+":db", () => {
		const db = new DatabaseSync(dbPath ? dbPath+"/"+userId+".db" : ":memory:");

		const { user_version } = db.prepare('PRAGMA user_version').get();
		cachePreparedSql(db);

		if (user_version === 0) {
			db.exec(`
${createConversations}
${createMessages}
${createKV}
${createKVS}
PRAGMA user_version = `+DB_VERSION);
		} else if (user_version < DB_VERSION) {
			console.log("正在更新用户数据 目标版本",DB_VERSION,"当前版本",user_version);
			if (user_version <= 1) {
				db.exec(`CREATE INDEX idx_conversations_time ON conversations(time)`);
			}
			if (user_version <= 2) {
				db.exec(`BEGIN TRANSACTION;`);

				const logs = db.prepare(`SELECT ROWID, data FROM "logs"`).all();
				const updateLog = db.prepare(`UPDATE "logs" SET data = ?WHERE ROWID = ?`);
				for (const row of logs) {
					const data = decompressLog(row.data);
					data.cost = Math.round(data.cost * 1000000);
					updateLog.run(compressLog(data), row.rowid);
				}

				db.exec(`COMMIT;`);
			}
			if (user_version <= 3) {
				// id, time, data
				const logs = db.prepare(`SELECT *FROM "logs" ORDER BY time`).all();
				const asyncUpdate = async () => {
					const tsdb = await ctx.logDB;
					for (const row of logs) {
						let data = row.data;
						const time = row.time;
						let id = row.id;
						if (typeof id !== "number" && id != null) {
							data = decompressLog(data);
							data.usage = id;
							data = await compressLog(data);
							id = NULL_OWNER;
						}
						tsdb.append(data, id || NULL_OWNER, time);
					}
				};
				asyncUpdate().then(() => {
					console.log("async logdb creation done");
				})

				db.exec("DROP TABLE logs");
			}
			console.log("更新成功");
			db.exec(`PRAGMA user_version = `+DB_VERSION);
		}

		db.exec(STARTUP_SQL);
		db.exec("PRAGMA optimize;");
		if (ENABLE_FILE_TRANSFER) {
			db.prepare("INSERT INTO conversations (id, title, time, data) VALUES (0, '文件传输助手', ?, ?) ON CONFLICT(id) DO NOTHING").run(
				Date.now(), compressMessage({ noAI: true })
			);
		}

		return db;
	});
}

// 数据库版本号
const DB_VERSION = 4;

const createConversations = `
	CREATE TABLE conversations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		title TEXT NOT NULL DEFAULT '',
		time INTEGER NOT NULL,
		data BLOB NOT NULL
	);
	CREATE INDEX idx_conversations_time ON conversations(time);
`;
const createMessages = `
	CREATE TABLE messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner INTEGER NOT NULL REFERENCES conversations(id),
		time INTEGER,
		content TEXT NOT NULL,
		data BLOB NOT NULL
	);
	CREATE INDEX idx_messages_owner ON messages(owner);
`;
const createKV = `
	CREATE TABLE kv (
		key TEXT PRIMARY KEY,
		value BLOB NOT NULL
	) WITHOUT ROWID;
`;
const createKVS = `
	CREATE TABLE kvs (
		type TEXT NOT NULL,
		name TEXT NOT NULL,
		data BLOB NOT NULL,
		PRIMARY KEY (type, name)
	) WITHOUT ROWID;
`;
