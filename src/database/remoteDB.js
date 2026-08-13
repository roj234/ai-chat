import {config, EVENT_BUS} from "../states.js";
import {decodeObjects, encodeObjects, serializeJSON} from "../utils/marshal.js";
import {initSync} from "./remoteSync.js";
import {decodeMsg, encodeMsg} from "unconscious/common/msgpack.js";
import {msgpack_schema, msgpack_schema_version} from "/common/MsgpackSchema.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {base64Encode} from "unconscious/common/Base64.js";
import {prettyError, resolveDBRelativeURL} from "../utils/utils.js";
import {$store, $update, AS_IS, unconscious} from "unconscious";
import SimpleModal from "../components/SimpleModal.jsx";
import {delta, patch, rep} from "unconscious/common/deepEqual.js";
import {PROTOCOL_VERSION} from "/backend/sync_const.js";
import {DIFF_SNAPSHOT, MESSAGES_CACHE} from "../database.js";
import {LRUCache} from "../../backend/utils/LRUCache.js";

let clientId;

const messageQueue = $store("mq", [], { persist: true, deep: false,
	ser(o) {
		return o.length ? JSON.stringify(o) : undefined;
	},
	deser(s) {
		return JSON.parse(s) || [];
	}
});

const serializeMsgpack = async (obj) => {
	const mapping = new Map;
	await encodeObjects(obj, mapping);
	return encodeMsg(obj, msgpack_schema, mapping.size ? (value) => mapping.get(value) ?? value : null);
};

/** @type {string} */
let dbUrl = config.db_server;
/** @type {boolean} */
let serverAcceptMsgpack;

export const requestBackend = async (path, {body, method} = {}) => {
	if (!dbUrl.endsWith('/')) config.db_server = dbUrl += '/';

	const headers = {
		'Accept': 'application/vnd.msgpack,application/json',
		'Content-Type': serverAcceptMsgpack ? 'application/vnd.msgpack' : 'application/json',
		'x-pv': PROTOCOL_VERSION,
		'x-sv': msgpack_schema_version,
	};
	if (clientId) headers["x-ci"] = clientId;

	const pat = config.db_pat;
	if (pat) headers["Authorization"] = 'Bearer '+pat;

	const init = {
		headers,
		method,
		body: body && await (serverAcceptMsgpack ? serializeMsgpack(body) : serializeJSON(body)),
		referrerPolicy: "no-referrer"
	};
	let res;
	try {
		res = await fetch(dbUrl+path, init);
	} catch {
		throw "请求失败，请检查网络";
	}

	const decode = () => {
		const contentType = res.headers.get('Content-Type');
		if (contentType === 'application/json') return res.json();
		if (contentType === 'application/vnd.msgpack') {
			serverAcceptMsgpack = true;
			return res.arrayBuffer().then(ab => {
				return decodeMsg(new DataView(ab), {
					bigint: true,
					schema: msgpack_schema
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

let prevError;

const runBatch = async () => {
	const queue = batchQueue;
	batchQueue = null;

	const mq = unconscious(messageQueue);
	let mqLength = mq.length;
	if (mqLength) {
		// 如果切换了数据库服务器
		if (!config._new) {
			for (const item of mq) {
				queue.push([await decodeObjects(JSON.parse(item)), AS_IS, AS_IS]);
			}
		}
		mq.length = 0;
	}

	requestBackend('batch', {
		method: "POST",
		body: queue.map(q => q[0])
	}).then(items => {
		for (let i = 0; i < queue.length; i++) {
			const item = items[i];
			const q = queue[i];
			const error = item?.error;
			error ? q[2](error) : q[1](item);
		}

		if (mqLength) {
			$update(messageQueue);
			requestIdleCallback(() => location.reload());
		}
	}).catch(async err => {
		// all request failed
		for (let q of queue) {
			q[2](err);

			/** @type {string} */
			let action = q[0][0];
			action = action.slice(action.indexOf("/")+1);
			if (action.startsWith("set") || action.startsWith("upsert") || action.startsWith("delete")) {
				mq.push(await serializeJSON(q[0]));
			}
		}

		if (mq.length) {
			$update(messageQueue);
			prevError?.remove();
			prevError = SimpleModal({
				title: "请求失败 ("+mq.length+")",
				message: `刷新页面将会自动重放请求\n\n详细错误信息：`+prettyError(err),
				confirmMessage: "刷新页面",
				onConfirm() {
					location.reload()
				}
			});
		}
	});
};

/**
 * @param {string} key
 * @param {boolean=false} unmarshal
 * @return {(function(*): Promise<any>)}
 */
const batched = (key, unmarshal) => value => {
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

const u_upsertConversation = batched("conversation/upsert");

export const upsertConversation = async conversation => conversation.id = await u_upsertConversation(conversation);
export const deleteConversation = batched("conversation/delete");

const u_getConversation = batched("conversation", true);
const u_messages = batched("messages", true);

export const getMessages = async conversation => {
	const id = conversation.id;
	const metadata = u_getConversation([id, conversation[MESSAGES_CACHE] && conversation.time]);
	const messages = u_messages(id);

	return metadata.then(json => {
		const readyState = conversation.ready;
		for (const key of Object.keys(conversation)) delete conversation[key];
		Object.assign(conversation, json);
		if (readyState != null) conversation.ready = readyState;
		conversation.id = id;
		return messages.catch(err => {
			if (err.status !== 304) throw err;
			return conversation[MESSAGES_CACHE];
		});
	});
};

const u_upsertMessage = batched("message/upsert");
export const upsertMessage = async message => message.id = await u_upsertMessage(message);
export const deleteMessage = batched("message/delete");

const showIncompatibleDialog = backendVersion => {
	SimpleModal({
		title: "通信协议不兼容",
		message:
			"检测到前后端通信协议版本不一致，可能导致功能异常或数据错误。\n\n" +
			`前端版本：${PROTOCOL_VERSION}\n` +
			`后端版本：${backendVersion}\n\n` +
			`建议：请更新${PROTOCOL_VERSION > backendVersion ? "后端" : "前端"}至匹配版本后再继续。\n` +
			"警告：数据无价，请勿在更新前执行写入操作。",
		confirmMessage: "了解风险，继续",
		accent: "danger",
		onCancel: null
	});
};

export const initialize = (rpcHandler) => {
	batched("version")().catch(err => {
		if (err.startsWith?.("unknown")) return ['Legacy'];
		throw err;
	}).then(([protocolVersion, maxUploadSize]) => {
		if (protocolVersion !== PROTOCOL_VERSION) {
			showIncompatibleDialog(protocolVersion);
		}
		maxBlobSize = maxUploadSize;
	});
	return batched("sync")().then(async syncServer => {
		if (syncServer) {
			clientId = await initSync(resolveDBRelativeURL(syncServer).replace(/^http/, "ws"), rpcHandler);
		}
	});
};

export const listConversations = batched("conversations");

export const searchMessages = keyword => requestBackend(`search?keyword=${encodeURIComponent(keyword)}`);

const u_getKV = batched("kv", true);
const u_setKV = batched("kv/set");
const u_deleteKV = batched("kv/delete");

/**
 *
 * @param {string} key
 * @param {import("unconscious").Reactive<*>=} val
 * @returns {Promise<*>}
 */
export const getKV = (key, val) => {
	let promise = u_getKV(key);
	if (val) promise.then(results => {
		EVENT_BUS.on(['kv', key], (value) => {val.value = value;});
		if (results != null) val.value = results;
	});
	return promise;
};
export const setKV = (key, value) => value === undefined ? u_deleteKV(key) : u_setKV([key, value]);

// values这个接口主要是给备份(导出)用的
export const kvListGetValues = batched("kvs/values", true);

const u_getKVListKeys = batched("kvs");

/**
 *
 * @param {string} type
 * @param {import("unconscious").Reactive<AiChat.IDBKVList[]>=} val
 * @returns {Promise<AiChat.IDBKVList[]>}
 */
export const kvListGetKeys = (type, val) => {
	let promise = u_getKVListKeys(type);
	if (val) promise.then(results => {
		EVENT_BUS.on(['kvs', type], (name, path) => {
			const idx = unconscious(val).findIndex(item => item.name === name);
			if (path[2] === 'del') {
				if (idx >= 0) val.splice(idx, 1);
			} else if (idx < 0) {
				val.unshift({name});
				//val.sort()
			}
		});
		val.value = results;
	});
	return promise;
};

const u_getKVList = batched("kvs/value", true);
const u_upsertKVList = batched("kvs/upsert");
const u_deleteKVList = batched("kvs/delete");

/** @type {Map<string, AiChat.IDBKVList & Object>} */
const kvsCache = new LRUCache(100);

EVENT_BUS.on(['kvs'], (name, path) => {
	kvsCache.delete(path[1]+':'+name);
});

/**
 * @param {string} type
 * @param {string} name
 * @return {Promise<Object>}
 */
export const kvListGet = async (type, name) => {
	if (!name) return;

	const cacheKey = type+":"+name;
	let val = kvsCache.get(cacheKey);
	if (!val) {
		val = await u_getKVList([type, name]);
		if (val) {
			delete val.type;
			val[DIFF_SNAPSHOT] = structuredClone(val);
			kvsCache.set(cacheKey, val);
		}
	}
	return val;
};

const KVLIST_IGNORE_KEYS = new Set(["name", "type"]);

/**
 * @param {Object} value
 * @param {string} type
 * @param {string=} name
 * @return {Promise<*>}
 */
export const kvListSet = async (value, type, name) => {
	if (name) value.name = name;
	else name = value.name;

	const cacheKey = type+":"+name;

	const prev = value[DIFF_SNAPSHOT];
	let diff;
	if (prev) {
		const prevName = prev.name;
		if (prevName !== name) kvsCache.delete(type+":"+prevName);

		diff = delta(prev, value, KVLIST_IGNORE_KEYS);
		if (!diff) return true;
		value[DIFF_SNAPSHOT] = patch(prev, structuredClone(diff));
	} else {
		diff = rep(value);
		value[DIFF_SNAPSHOT] = structuredClone(value);
	}

	kvsCache.set(cacheKey, value);

	return u_upsertKVList({
		type,
		name,
		...diff
	}).then(() => EVENT_BUS.post(['kvs', type, 'set'], name));
};

export const kvListDel = (type, name) => u_deleteKVList([type, name]).then(() => EVENT_BUS.post(['kvs', type, 'del'], name));

export const appendBillingLog = batched("log/insert");
export const getBillingLog = batched("log");

const queryLogs = batched(`logs`);
export const listBillingLogs = (...argList) => queryLogs(argList);

export const deleteDatabase = async () => requestBackend('database', {method: 'DELETE'});

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
	async blob() {return this[BLOB] || (this[BLOB] = await (await fetch(this.toUrl(), { cache: 'force-cache', integrity: 'sha256-'+this.hash })).blob());},
	async toDataURL() {return (await this.blob()).toDataURL();},
	async arrayBuffer() {return (await this.blob()).arrayBuffer();},
	async bytes() {return (await this.blob()).bytes();},
	async text() {return (await this.blob()).text();},
};

const u_getBlobInfo = batched("blob");

let maxBlobSize;

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
		if (maxBlobSize && blob.size > maxBlobSize) throw '文件 '+blob.hash+' 过大';

		let url = dbUrl+`blob/`+hash+"?name="+encodeURIComponent(blob.name||"")+"&time="+(blob.lastModified||"");
		let res;
		try {
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': blob.type,
					'Authorization': 'Bearer '+(config.db_pat||'')
				},
				body: blob
			});
		} catch {
			throw "上传失败，请检查网络";
		}
		if (!res.ok) throw await res.text();
	}
	return blob.hash = hash;
};

/**
 *
 * @param {{hash: string, name: string}} obj
 * @return {Promise<Blob>}
 */
export const getBlob = async ({hash, name}) => {
	const serverData = await u_getBlobInfo(hash).catch((e) => {
		return {
			size: -1,
			type: e
		}
	});
	if (name) serverData.name = name;
	return new _FakeBlob({ hash, ...serverData });
};