import {compressGeneric, decompressGeneric, deserializeRow} from "../utils/compression.js";
import {patch} from "unconscious/common/deepEqual.js";

/**
 * @param {Record<string, function(body: any, ctx: Partial<AiChatBackend.RouteContext>): any>} batcher
 */
export function registerKVRoutes(batcher) {
	batcher["kv"] = (key, {db})  => {
		const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
		return row && decompressGeneric(row.value);
	};

	batcher["kv/set"] = async ([key, value], {db}) => {
		if (!key) return { error: 'missing key' };

		db.prepare('REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, await compressGeneric(value));
		return true;
	};

	batcher["kv/delete"] = (key, {db}) => {
		if (!key) return { error: 'missing key' };
		const info = db.prepare('DELETE FROM kv WHERE key = ?').run(key);
		return info.changes > 0;
	};

	batcher["kvs"] = (type, {db}) => {
		return db.prepare('SELECT name FROM kvs WHERE type = ?').all(type);
	};

	batcher["kvs/values"] = (type, {db}) => {
		return (type === '*' ? db.prepare('SELECT * from kvs').all() : db.prepare('SELECT * FROM kvs WHERE type = ?').all(type)).map(item => deserializeRow(item));
	};

	batcher["kvs/value"] = ([type, name], {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		const row = db.prepare('SELECT * FROM kvs WHERE type = ? AND name = ?').get(type, name);
		if (!row) return { error: `${type} ${JSON.stringify(name)} not found` };

		return deserializeRow(row);
	};

	batcher["kvs/upsert"] = async ({ type, name, ...diff }, {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		if (diff.$ === 'SET') {
			diff = diff.val;
		} else {
			const row = db.prepare('SELECT * FROM kvs WHERE type = ? AND name = ?').get(type, name);
			if (!row) return { error: `${type} ${JSON.stringify(name)} not found` };

			diff = patch(deserializeRow(row), diff);
		}
		if (typeof diff !== 'object') return { error: 'data must be object' };
		if ("error" in diff) return { error: '"error" in data' };
		delete diff.type;
		delete diff.name;

		db.prepare('REPLACE INTO kvs (type, name, data) VALUES (?, ?, ?)').run(type, name, await compressGeneric(diff));
		return true;
	};

	batcher["kvs/delete"] = ([type, name], {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		const info = db.prepare('DELETE FROM kvs WHERE type = ? AND name = ?').run(type, name);
		return info.changes > 0;
	};
}