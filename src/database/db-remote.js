import {config} from "../states.js";
import {decodeObjects, encodeObjects, serializeJSON} from "../utils/marshal.js";
import {initSync, SYNC_CONVERSATION, SYNC_MESSAGE} from "./SyncManager.js";
import {decodeMsg, encodeMsg} from "unconscious/common/msgpack.js";
import {c2s_schema, c2s_schema_version, s2c_schema, s2c_schema_version} from "/common/MsgpackSchema.js";

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
			text = JSON.stringify(text);
		}
		throw `HTTP ${res.status}\n${text}`;
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
export const deleteConversation = id => {
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
		return messages;
	});
};

export const upsertMessage = async message => {
	const id = message.id = await u_upsertMessage(message);
	sync?.on(SYNC_MESSAGE, message);
	return id;
};

export const deleteMessage = id => {
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
		if (val) kvListCache.set(cacheKey, new WeakRef(val));
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

export const deleteDatabase = async () => request('database', {method: 'DELETE'});

const URLSAFE = {
	'+': '-',
	'/': '_',
	'=': ''
};

/**
 * 使用 SubtleCrypto 计算 Blob 的 SHA-256（十六进制字符串）
 * 注意：大文件会一次性加载到内存，可能造成卡顿
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export const sha256 = async blob => {
	// Web Crypto 好垃圾哦
	const buffer = await blob.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
	return btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replaceAll(/[+\/=]/g, match => URLSAFE[match]);
};

const BLOB = Symbol();

function _FakeBlob(hash, type, name, size) {
	this.hash = hash;
	this.type = type;
	this.name = name;
	this.size = size;
}
_FakeBlob.prototype = {
	constructor: File,
	toUrl() {return dbUrl+`blob/`+this.hash;},
	async _fetch() {return this[BLOB] || (this[BLOB] = await (await fetch(this.toUrl())).blob());},
	async toDataURL() {return (await this._fetch()).toDataURL();},
	async arrayBuffer() {return (await this._fetch()).arrayBuffer();},
	async bytes() {return (await this._fetch()).bytes();},
	async text() {return (await this._fetch()).text();},
};

const u_blob = makeBatch("blob");

/**
 *
 * @param {Blob|_FakeBlob} blob
 * @return {Promise<string>}
 */
export const updateBlob = async blob => {
	const existingHash = blob.hash;
	if (existingHash) return existingHash;

	const hash = await sha256(blob);
	try {
		await u_blob(hash);
	} catch {
		const resp = await fetch(dbUrl+`blob/`+hash+"?name="+encodeURIComponent(blob.name||""), {
			method: 'POST',
			headers: { 'Content-Type': blob.type },
			body: blob
		});
		if (!resp.ok) throw await resp.text();
	}
	return hash;
};

/**
 *
 * @param {{hash: string, name: string}} obj
 * @return {Promise<Blob>}
 */
export const getBlob = async ({hash, name}) => {
	const { name: serverName, type, size } = await u_blob(hash);
	return new _FakeBlob(hash, type || "application/octet-stream", name, size);
};