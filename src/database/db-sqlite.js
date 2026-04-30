// db-sqlite.js

import {SETTINGS} from "../settings.js";
import {config} from "../states.js";
import {decodeObjects, encodeObjects} from "../utils/marshal.js";
import {onLoad} from "../plugin.js";
import {initSync} from "./SyncManager.js";

let sync;

SETTINGS.push({
	id: "db_endpoint",
	name: "数据库后端地址",
	title: "提供文件管理、消息搜索、多租户等功能\n修改后需要刷新页面才能生效",
	type: "input",
	pattern: /^(\/|https?:\/\/).+\/aichat\/v2/,
	warning: "请输入合法的API端点",
	placeholder: "/aichat/v2/username"
});

let dbUrl = import.meta.env.DEV ? config.db_endpoint || "/aichat/v2/user" : config.db_endpoint;

onLoad(() => {
	request("props").then(data => {
		if (data.sync) sync = initSync(data.sync.replace(/^http/, "ws"));
	});
})

async function request(path, options = {}) {
	const res = await fetch(dbUrl+'/'+path, {
		headers: { 'Content-Type': 'application/json' },
		...options,
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
	return request(`conversations/${conversation.id}/messages`).then(decodeObjects);
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
	return request('conversations').then(decodeObjects);
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
	if (log.message_id == null) return Promise.resolve(); // 原行为直接返回DONE
	return request('billing', {
		method: 'POST',
		body: JSON.stringify(log),
	});
}

export function getBillingLog(message_id) {
	if (message_id == null) return Promise.resolve(); // 原行为返回DONE? 但原函数返回DONE也不是null，这里应该返回null或空？原函数：getBillingLog(message_id) { if (message_id == null) return DONE; ...} DONE是Promise.resolve()，那么返回就是Promise<undefined>。为了类型兼容，可以返回Promise.resolve(null)。
	return request(`billing/${message_id}`);
}

export async function deleteDatabase() {
	return request('database', { method: 'DELETE' });
}

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
	return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 *
 * @param {Blob} blob
 * @return {Promise<string>}
 */
export async function updateBlob(blob) {
	const hash = await sha256(blob);
	let resp = await fetch(dbUrl+`/blob/`+hash);
	if (!resp.ok) {
		resp = await fetch(dbUrl+`/blob/`+hash, {
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
 * @param {{hash: string, type: string}} obj
 * @return {Promise<Blob>}
 */
export async function getBlob(obj) {
	return (await fetch(dbUrl+`/blob/`+obj.hash)).blob();
}