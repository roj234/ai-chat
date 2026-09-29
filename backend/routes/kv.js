import {
	compressGeneric,
	compressKVS,
	decompressGeneric,
	decompressorKVS,
	deserializeRow
} from "../utils/compression.js";
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
		return db.prepare('SELECT name, meta FROM kvs WHERE type = ?').all(type).map(item => deserializeRow(item, decompressorKVS(type)));
	};

	batcher["kvs/values"] = (type, {db}) => {
		return (type === '*' ? db.prepare('SELECT * from kvs').all() : db.prepare('SELECT * FROM kvs WHERE type = ?').all(type)).map(item => deserializeRow(item, decompressorKVS(type)));
	};

	batcher["kvs/value"] = ([type, name], {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		const row = db.prepare('SELECT * FROM kvs WHERE type = ? AND name = ?').get(type, name);
		if (!row) return { error: `${type} ${JSON.stringify(name)} not found` };

		return deserializeRow(row, decompressorKVS(type));
	};

	batcher["kvs/upsert"] = async ({ type, name, ...diff }, {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		let updateBigBlob = true;
		if (diff.$ === '=') {
			diff = diff.v;
		} else {
			const keys = Object.keys(diff);
			updateBigBlob = keys.length > 1 || keys[0] !== 'meta';

			const row = db.prepare(`SELECT meta ${updateBigBlob?",data":""} FROM kvs WHERE type = ? AND name = ?`).get(type, name);
			if (!row) return { error: `${type} ${JSON.stringify(name)} not found` };

			diff = patch(deserializeRow(row, decompressorKVS(type)), diff);
		}
		if (typeof diff !== 'object') return { error: 'data must be object' };
		if ("error" in diff) return { error: '"error" in data' };

		const meta = diff.meta;
		delete diff.type;
		delete diff.name;
		delete diff.meta;

		const metaBytes = meta == null ? null : await compressGeneric(meta);
		if (metaBytes?.length > 255) return { error: '"meta" too big, exceeds 255B limit' }

		if (updateBigBlob) {
			db.prepare('REPLACE INTO kvs (type, name, meta, data) VALUES (?, ?, ?, ?)').run(type, name, metaBytes, await compressKVS(diff, type));
		} else {
			db.prepare('UPDATE kvs SET meta = ? WHERE type = ? AND name = ?').run(metaBytes, type, name);
		}
		return true;
	};

	batcher["kvs/delete"] = ([type, name], {db}) => {
		if (!type || !name) return { error: 'type and name required' };

		const info = db.prepare('DELETE FROM kvs WHERE type = ? AND name = ?').run(type, name);
		return info.changes > 0;
	};
}