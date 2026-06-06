import {config} from "../states.js";
import {decodeObjects, encodeObjects, serializeJSON} from "../utils/marshal.js";
import {initSync, SYNC_CONVERSATION, SYNC_MESSAGE} from "./SyncManager.js";
import {decodeMsg, encodeMsg} from "unconscious/common/msgpack.js";
import {c2s_schema, c2s_schema_version, s2c_schema, s2c_schema_version} from "/common/MsgpackSchema.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {base64Encode} from "unconscious/common/Base64.js";

let sync;

/** @type {string} */
let dbUrl = config.db_server;

let serverAcceptMsgpack;

export const serializeMsgpack = async (obj) => {
	const mapping = new Map;
	await encodeObjects(obj, mapping);
	return encodeMsg(obj, c2s_schema, mapping.size ? (value) => mapping.get(value) ?? value : null);
};

const request = async (path, {body, method} = {}) => {
	if (!dbUrl.endsWith('/')) dbUrl += '/';
	const res = await fetch(dbUrl+path, {
		headers: {
			'Accept': 'application/vnd.msgpack,application/json',
			'x-schema-version': s2c_schema_version,
			'Content-Type': serverAcceptMsgpack ? 'application/vnd.msgpack' : 'application/json'
		},
		method,
		body: body && await (serverAcceptMsgpack ? serializeMsgpack(body) : serializeJSON(body)),
		referrerPolicy: "no-referrer"
	});

	const decode = () => {
		const contentType = res.headers.get('Content-Type');
		if (contentType === 'application/json') return res.json();
		if (contentType === 'application/vnd.msgpack') {
			return res.arrayBuffer().then(ab => {
				return decodeMsg(new DataView(ab), {
					//multiple: true,
					bigint: true,
					schema: s2c_schema
				});
			});
		}
		return res.text();
	};

	if (!res.ok) {
		let text = await decode();
		if (typeof text !== "string") {
			text.status = res.status;
			throw text;
		}

		throw {
			status: res.status,
			error: text
		};
	}
	return decode();
};

/**
 * @type {Array}
 */
let batchQueue;

const runBatch = () => {
	const queue = batchQueue;
	batchQueue = null;

	request('batch', {
		method: "POST",
		body: queue.map(q => q[0])
	}).then(items => {
		for (let i = 0; i < queue.length; i++){
			const item = items[i];
			queue[i][item?.error ? 2 : 1](item);
		}
	}).catch(err => {
		for (let q of queue) q[2](err);
	});
};

/**
 * @param {string} key
 * @param {boolean=false} unmarshal
 * @return {(function(*): Promise<any>)}
 */
const makeBatch = (key, unmarshal) => value => {
	const promise = new Promise((resolve, reject) => {
		const data = [ [key, value], resolve, reject ];
		if (!batchQueue) {
			batchQueue = [data];
			setTimeout(runBatch);
		} else {
			batchQueue.push(data);
		}
	});
	return unmarshal ? promise.then(decodeObjects) : promise;
};

const u_upsertConversation = makeBatch("conversation/upsert");
const u_deleteConversation = makeBatch("conversation/delete");

export const upsertConversation = async conversation => {
	const id = conversation.id = await u_upsertConversation(conversation);
	sync?.on(SYNC_CONVERSATION, conversation);
	return id;
};
export const deleteConversation = (id) => {
	sync?.on(SYNC_CONVERSATION, {id});
	return u_deleteConversation(id);
};

const u_getConversation = makeBatch("conversation", true);
const u_messages = makeBatch("messages", true);
const u_upsertMessage = makeBatch("message/upsert");
const u_deleteMessage = makeBatch("message/delete");

export const getMessages = conversation => {
	const id = conversation.id;
	const messages = u_messages(id);
	return u_getConversation(id).then(json => {
		for (const key of Object.keys(conversation)) delete conversation[key];
		Object.assign(conversation, json);
		conversation.id = id;
		return messages;
	});
};

export const upsertMessage = async message => {
	const id = message.id = await u_upsertMessage(message);
	sync?.on(SYNC_MESSAGE, message);
	return id;
};

export const deleteMessage = (id, conversation) => {
	sync?.on(SYNC_MESSAGE, {id});
	return u_deleteMessage(id);
};

export const listConversations = () => {
	makeBatch("sync")().then(syncServer => {
		if (syncServer) {
			if (syncServer.startsWith("/")) {
				syncServer = (<a href={syncServer} />).href;
			}
			sync = initSync(syncServer.replace(/^http/, "ws"));
		}
	});
	makeBatch("msgpack")().then(version => serverAcceptMsgpack = version === c2s_schema_version);
	return makeBatch("conversations")();
};

export const searchMessages = keyword => request(`search?keyword=${encodeURIComponent(keyword)}`);

export const getKV = makeBatch("kv", true);
const u_setKV = makeBatch("kv/set");
const u_deleteKV = makeBatch("kv/delete");

export const setKV = async (key, value) => value === undefined ? u_deleteKV(key) : u_setKV([key, value]);

// values这个接口主要是给备份(导出)用的
export const kvListGetValues = makeBatch("kvs/values", true);
export const kvListGetKeys = makeBatch("kvs");
const u_getKVList = makeBatch("kvs/value", true);
const u_upsertKVList = makeBatch("kvs/upsert");
const u_deleteKVList = makeBatch("kvs/delete");

/** @type {Map<string, WeakRef<AiChat.IDBKVList & Object>>} */
const kvListCache = new Map;

/**
 * @param {string} type
 * @param {string} name
 * @return {Promise<Object>}
 */
export const kvListGet = async (type, name) => {
	if (!name) return;

	const cacheKey = type+":"+name;
	const ref = kvListCache.get(cacheKey);
	let val = ref?.deref();
	if (!val) {
		if (ref) {
			kvListCache.forEach((value, key) => {
				if (!value.deref()) kvListCache.delete(key);
			});
		}

		val = await u_getKVList([type, name]);
		delete val.type;
		if (val) kvListCache.set(cacheKey, new WeakRef(structuredClone(val)));
	}
	return val;
};

export const kvListSet = async (value, type, name) => {
	if (type) value.type = type;
	if (name) value.name = name;
	return u_upsertKVList(value);
};

export const kvListDel = (type, name) => u_deleteKVList([type, name]);

export const appendBillingLog = makeBatch("log/insert");
export const getBillingLog = makeBatch("log");

export const blobByName = makeBatch("blob-by-name");
export const blobSetName = makeBatch("blob/set-name");

export const deleteDatabase = async () => request('database', {method: 'DELETE'});

/**
 * 计算 Blob 的 SHA-256 注意 前后端哈希函数需要统一否则会上传失败
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export const blobHash = async blob => {
	let arrayBuffer;

	if (blob.size < 1048576 * 32) {
		// Web Crypto 好垃圾哦
		// 这时候我就怀念 Java 的手操内存了
		const buffer = await blob.arrayBuffer();
		arrayBuffer = await crypto.subtle.digest('SHA-256', buffer);
	} else {
		const hasher = new SHA256();

		const reader = blob.stream().getReader();
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;
			hasher.update(value);
		}

		arrayBuffer = hasher.digest();
	}

	return base64Encode(new Uint8Array(arrayBuffer), true);
};

const BLOB = Symbol();

function _FakeBlob(obj) {this.$='BlobH';Object.assign(this, obj);}
_FakeBlob.prototype = {
	constructor: File,
	toUrl() {return dbUrl+`blob/`+this.hash;},
	async blob() {return this[BLOB] || (this[BLOB] = await (await fetch(this.toUrl())).blob());},
	async toDataURL() {return (await this.blob()).toDataURL();},
	async arrayBuffer() {return (await this.blob()).arrayBuffer();},
	async bytes() {return (await this.blob()).bytes();},
	async text() {return (await this.blob()).text();},
};

const u_getBlobInfo = makeBatch("blob");

/**
 *
 * @param {File|_FakeBlob} blob
 * @return {Promise<string>}
 */
export const uploadBlob = async blob => {
	const existingHash = blob.hash;
	if (existingHash) return existingHash;

	const hash = await blobHash(blob);
	try {
		await u_getBlobInfo(hash);
	} catch {
		let url = dbUrl+`blob/`+hash+"?name="+encodeURIComponent(blob.name||"")+"&time="+(blob.lastModified||"");
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': blob.type },
			body: blob
		});
		if (!resp.ok) throw await resp.text();
	}
	return blob.hash = hash;
};

/**
 *
 * @param {{hash: string, name: string}} obj
 * @return {Promise<Blob>}
 */
export const getBlob = async ({hash, name}) => {
	const serverData = await u_getBlobInfo(hash).catch(() => {});
	if (name) serverData.name = name;
	return new _FakeBlob({ hash, ...serverData });
};