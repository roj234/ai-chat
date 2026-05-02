import {config} from "../states.js";
import {decodeObjects, encodeObjects} from "../utils/marshal.js";
import {initSync} from "./SyncManager.js";
import SimpleModal from "../components/SimpleModal.jsx";
import {showToast} from "../components/Toast.js";
import {DONE} from "../database.js";

let sync;

/** @type {string} */
let dbUrl = config.db_server;

async function request(path, options = {}) {
	if (!dbUrl.endsWith('/')) dbUrl += '/';
	const res = await fetch(dbUrl+path, {
		headers: { 'Content-Type': 'application/json' },
		...options,
		referrerPolicy: "no-referrer"
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`HTTP ${res.status}: ${text}`);
	}
	const contentType = res.headers.get('Content-Type');
	if (contentType && contentType.includes('application/json')) {
		return res.json();
	}
	return res.text();
}

export async function serializeJSON(obj) {
	const mapping = new Map;
	const replacer = (_, value) => {
		return mapping.get(value) ?? value;
	};
	await encodeObjects(obj, mapping);
	return JSON.stringify(obj, replacer);
}

export function getMessages(conversation) {
	return request(`conversations/${conversation.id}`).then(async json => {
		Object.assign(conversation, await decodeObjects(json));
		return request(`conversations/${conversation.id}/messages`).then(decodeObjects);
	});
}

export async function newConversation(conversation) {
	const body = await serializeJSON(conversation);

	const result = await request('conversations', {
		method: 'POST',
		body,
	});

	conversation.id = result.id;
	sync?.on('update', conversation);
	return conversation;
}

export async function updateConversation(conversation) {
	sync?.on('update', conversation);
	const body = await serializeJSON(conversation);

	return await request(`conversations/${conversation.id}`, {
		method: 'PUT',
		body,
	});
}

export async function updateMessage(message) {
	const body = await serializeJSON(message);
	const result = await request('messages', {
		method: 'POST',
		body,
	});

	message.id = result.id;
	return message;
}

export function deleteMessage(id) {
	return request(`messages/${id}`, { method: 'DELETE' });
}

export function deleteConversation(id) {
	sync?.on('delete', id);
	return request(`conversations/${id}`, { method: 'DELETE' });
}

export function listConversations() {
	const next = () => {
		request("props").then(data => {
			let syncServer = data.sync;
			if (syncServer) {
				if (syncServer.startsWith("/")) {
					syncServer = (<a href={syncServer} />).href;
				}
				sync = initSync(syncServer.replace(/^http/, "ws"));
			}
		});
		return request('conversations').then(decodeObjects);
	};

	if (config.db_server && (DB_MODE !== 'remote' || config.db_server !== ':idb:')) return next();

	return new Promise(resolve => {
		SimpleModal({
			type: "input",
			title: "登录",
			message: "请输入"+(DB_SERVER?"用户名或":"")+"数据库服务器地址\n之后也可以在设置页面修改"+(DB_MODE === "mixed" ? "\n您也可以点击取消使用本地数据库": ""),
			placeholder: (DB_SERVER?"新用户将直接注册":"")+(import.meta.env.DEV?"\n留空使用开发服务器调试账户":""),
			confirmMessage: "登录",
			onConfirm(value) {
				if (!value) {
					if (import.meta.env.DEV) {
						value = "/aichat/v2/user";
						showToast("您正使用开发服务器调试账户");
					} else {
						return false;
					}
				}

				if (!value.toLowerCase().startsWith("http") && !value.startsWith("/")) {
					if (DB_SERVER) {
						value = DB_SERVER.replace("{{user}}", encodeURIComponent(value));
					} else {
						return false;
					}
				}
				config.db_server = dbUrl = value;
				location.reload();
			},
			onCancel(value) {
				if (DB_MODE !== 'mixed') return false;
				config.db_server = ':idb:';
				location.reload();
			}
		});
		}
	);
}

export function searchMessages(keyword) {
	return request(`search?keyword=${encodeURIComponent(keyword)}`);
}

export function getKV(key) {
	return request(`kv?key=${encodeURIComponent(key)}`).then(decodeObjects);
}

export async function setKV(key, value) {
	if (value === undefined) {
		return request(`kv?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
	}

	const body = await serializeJSON({ key, value });
	return request('kv', {
		method: 'PUT',
		body: body,
	});
}

export function kvListGetValues(type) {
	return request(`kvs?type=${encodeURIComponent(type)}`).then(decodeObjects);
}

export function kvListGetKeys(type) {
	return request(`kvs/keys?type=${encodeURIComponent(type)}`);
}

export function kvListGet(key) {
	return request(`kvs/${key}`).then(decodeObjects);
}

export function kvListGetByName(type, name) {
	return request(`kvs/by-name?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`).then(decodeObjects);
}

export async function kvListSet(value, type, name) {
	if (type) value.type = type;
	if (name) value.name = name;

	const body = await serializeJSON(value);

	if (value.id != null) {
		// 有id则更新
		await request(`kvs/${value.id}`, { method: 'PUT', body });
		return value.id;
	} else {
		// 无id则创建
		const newItem = await request('kvs', { method: 'POST', body });
		return newItem.id;
	}
}

export function kvListDel(key) {
	return request(`kvs/${key}`, { method: 'DELETE' });
}

export function appendBillingLog(log) {
	if (log.message_id <= 0) return DONE;
	return request('log', {
		method: 'POST',
		body: JSON.stringify(log),
	});
}

export function getBillingLog(message_id) {
	if (message_id <= 0) return DONE;
	return request(`log/${message_id}`);
}

export async function deleteDatabase() {
	return request('database', { method: 'DELETE' });
}

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
export async function sha256(blob) {
	// Web Crypto 好垃圾哦
	const buffer = await blob.arrayBuffer();
	const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
	return btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replaceAll(/[+\/=]/g, match => URLSAFE[match]);
}

/**
 *
 * @param {Blob} blob
 * @return {Promise<string>}
 */
export async function updateBlob(blob) {
	const hash = await sha256(blob);
	let resp = await fetch(dbUrl+`blob/`+hash);
	if (!resp.ok) {
		resp = await fetch(dbUrl+`blob/`+hash, {
			method: 'POST',
			headers: { 'Content-Type': blob.type },
			body: blob
		});
		if (!resp.ok) {
			throw await resp.text();
		}
	}
	return hash;
}

/**
 *
 * @param {{hash: string, name: string}} obj
 * @return {Promise<Blob>}
 */
export async function getBlob({hash, name}) {
	const blob = await (await fetch(dbUrl+`blob/`+hash)).blob();
	if (name) blob.name = name;
	return blob;
}