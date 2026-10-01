import {SSE_PROXY_BACKEND, SSE_REF_CACHE_SIZE, SSE_REF_TTL} from "../config.js";
import {LRUCache} from "../../common/LRUCache.js";
import {blobDB} from "./blob-storage.js";
import path from "node:path";
import {openAsBlob} from "node:fs";
import {deepEntries} from "unconscious/common/json-schema-utils.js";

export const apiProxyLog = (str, ...args) => console.log(`[SSE Proxy] `+str, ...args);

/**
 * 消息引用缓存：hash -> 完整消息对象
 * 命中后客户端无需重复上传历史消息内容，仅引用 hash
 * @type {LRUCache<string, OpenAI.Message[]>}
 */
let messageCache;

/**
 * @param {OpenAI.Message[]} messages
 * @param {string} blobDir
 * @returns {Promise<[OpenAI.Message[], string[]]>}
 */
export async function processMessageRefs(messages, blobDir) {
	if (messageCache?.capacity !== SSE_REF_CACHE_SIZE) {
		messageCache = new LRUCache(SSE_REF_CACHE_SIZE, SSE_REF_TTL ? { ttlMode: "access" } : null);
	}

	const missing = new Set;
	const created = new Set;
	const output = [];

	let blockIndex, blockHash;

	const endCacheBlock = () => {
		if (blockHash) {
			if (blockIndex === i) throw new Error("Empty cache_block");
			messageCache.set(blockHash, messages.slice(blockIndex, i), SSE_REF_TTL);
			created.add(blockHash);
			blockHash = null;
		}
	};

	let i = 0;
	for (; i < messages.length; i++) {
		const m = messages[i];

		if (m.role === 'cache_end') {
			endCacheBlock();
		} else if (m.role === 'cached') {
			endCacheBlock();

			const cached = messageCache.get(m.id);
			if (!cached) missing.add(m.id);
			else output.push(...cached);
		} else if (m.role === 'cache_new') {
			endCacheBlock();

			blockHash = m.id;
			if (!blockHash) throw new Error("Invalid hash in cache_block");
			blockIndex = i+1;
		} else {
			output.push(m);
		}
	}
	endCacheBlock();

	if (missing.size) return [null, [...missing]];

	const tasks = [];

	for (const [val, own, key] of deepEntries(output)) {
		if (val?.$ === 'BlobH') {
			const hash = val.hash;
			const hashBuf = Buffer.from(hash, 'base64url');
			const row = blobDB.prepare('SELECT name, type FROM blobs WHERE hash = ?').get(hashBuf);

			const err = () => {throw new Error("附件 "+(val.name || row?.name || hash)+" 丢失或损坏");};
			if (!row) err();

			const filePath = path.join(blobDir, hash.slice(0, 2).toLowerCase(), hash);
			tasks.push(openAsBlob(filePath, { type: row.type }).then((blob) => {
				Object.defineProperty(blob, 'hash', { value: hash, enumerable: true });
				own[key] = blob;
			}, err));
		}
	}
	await Promise.all(tasks);

	return [output, [...created]];
}

export function checkToken(ctx) {
	let {authorization} = ctx.req.headers;
	if (!authorization?.startsWith("Bearer ")) return ctx.send(403, { error: 'unknown key' });
	authorization = authorization.slice(7);

	let target = SSE_PROXY_BACKEND[authorization] || SSE_PROXY_BACKEND['default'];
	if (!target?.url) return ctx.send(403, { error: 'unknown key' });
	if (!target.authorization) {
		target = {
			...target,
			authorization
		}
	}

	return target;
}
