import {
	getImmediateMessages,
	getMessages,
	kvListDel,
	kvListGet,
	kvListGetKeys,
	kvListSet,
	markMessageDirty,
	updateConversation
} from "/src/database.js";
import {conversations, findConversation, LOCKED, selectedConversation} from "/src/states.js";
import {JsonFile, SimpleDirectory, VHandle} from "./VirtualFileSystem.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {createWebFileSystem} from "./WebFSDriver.js";
import {resolveDirectory} from "./WebFSUtils.js";
import {$update, unconscious} from "unconscious";
import {FSE_AccessDenied, FSE_NotFound, throwDOMException} from "/common/pure-utils.js";

const BLACKLIST_CHARS = /[| &=?#{}<>:,/]/g;

const fakeMetadata = () => ({
	size: -1,
	lastModified: Date.now()
});

const FAKE_DIR_CONSTANT = {};
const FAKE_FILE_CONSTANT = {read: fakeMetadata};

/**
 * 对路径字符串中的「非法字符」进行 URI 转义
 * @param {string} str - 原始路径字符串
 * @returns {string} 转义后的路径字符串（仅黑名单字符被编码）
 */
const fileEscape = (str) => str.replaceAll(BLACKLIST_CHARS, encodeURIComponent);

/** 校验并剥离 .json 后缀 */
const checkJson = (name) => {
	if (!name.endsWith(".json")) throw (`Invalid file name: ${name}`);
	return name.slice(0, -5);
};

const CFG_ROOTS = new NestedMap();

const kvsTypes = ["st|char", "st|preset", "st|lorebook", "preset"];

const kvsHandler = JsonFile({
	async meta(path) {
		const [type, name] = path.at(-2);
		const kvs = await kvListGet(type, name);
		return [kvs.time, kvs];
	},
	write(value, path) {
		const [type, name] = path.at(-2);
		return kvListSet(value, type, name);
	}
});

for (const type of kvsTypes) {
	/**
	 * @type {AiChat.VirtualDirectoryHandleHandler}
	 */
	const handler = {
		child(pathArray, dir) {
			if (!dir) return;
			pathArray[pathArray.length - 1] = [type, decodeURIComponent(pathArray.at(-1))];
			return new SimpleDirectory().add('data.json', kvsHandler);
		},
		async *entries() {
			const keys = await kvListGetKeys(type);
			for (const {name} of keys) yield [fileEscape(name), FAKE_DIR_CONSTANT];
		},
		rm(name) {return kvListDel(type, name);}
	};

	CFG_ROOTS.set(["kvs", fileEscape(type)], handler);
}

/**
 * @type {AiChat.VirtualDirectoryHandleHandler}
 */
const messagesHandler = {
	async child(childPath, dir) {
		if (dir) return;

		const name = childPath.at(-1);
		const conv = childPath.at(-3);
		const msgs = await getMessages(conv);

		if (name === 'insert') {
			childPath[childPath.length - 1] = -1;
			return messageHandler;
		}

		const id =  parseInt(checkJson(name), 10);
		const index = msgs.findIndex(m => m.id === id);
		if (index < 0) throwDOMException(`Message #${id}`, FSE_NotFound);

		childPath[childPath.length - 1] = index;
		return messageHandler;
	},
	async *entries(path) {
		const conv = path.at(-2);
		for (const message of await getMessages(conv)) {
			yield [message.id+".json", FAKE_FILE_CONSTANT];
		}
		yield ["insert", FAKE_FILE_CONSTANT];
	},
	async rm(name, recursive, path) {
		const conv = path.at(-2);
		const id = parseInt(checkJson(name), 10);

		const msgs = await getMessages(conv);
		const index = msgs.findIndex(m => m.id === id);
		if (index < 0) throw (`Message ${id} not found`);
		msgs.splice(index, 1);
		await updateConversation(conv, msgs, 1);
	}
};
const messageHandler = JsonFile({
	meta(path) {
		const conv = path.at(-3);
		const msgs = getImmediateMessages(conv);
		const index = path.at(-1);

		const msg = msgs[index];
		return [msg?.time, msg];
	},
	async write(obj, path) {
		const conv = path.at(-3);
		const msgs = getImmediateMessages(conv);
		const index = path.at(-1);

		if (index === -1) {
			delete obj.id;
			delete obj.parent;
			msgs.push(obj);
		} else {
			if (obj.id !== msgs[index].id) throwDOMException(`ID mismatch, from name=${msgs[index].id}, from data=${obj.id}`, FSE_AccessDenied);
			const parent = msgs[index].parent;
			if (parent != null) obj.parent = parent;
			msgs[index] = obj;
		}
		markMessageDirty(obj);
		await updateConversation(conv, msgs);
	},
})
const metaHandler = JsonFile({
	meta(path) {
		const conv = path.at(-2);
		return [conv.time, conv];
	},
	async write(data, path) {
		const conv = path.at(-2);
		const id = conv.id;

		for (const key in conv) delete conv[key];
		Object.assign(conv, data);
		conv.id = id;

		await updateConversation(conv);
		$update(conversations);
	},
});
const sessionHandler = new SimpleDirectory().add('messages', messagesHandler).add('session.json', metaHandler);

CFG_ROOTS.set(["sessions"], {
	child(childPath, dir) {
		if (!dir) return;

		const name = childPath.at(-1);
		const id = parseInt(name, 10);
		const conv = findConversation(id);
		if (conv) {
			if (id === selectedConversation.id || conv[LOCKED]) throw new DOMException("This conversation is opening", "ReadOnlyError");
			childPath[childPath.length - 1] = conv;
			return sessionHandler;
		}
	},
	*entries() {
		for (const {id} of unconscious(conversations)) {
			yield [String(id), FAKE_DIR_CONSTANT];
		}
	}
});

const configFS_root = new VHandle(CFG_ROOTS, []);

/**
 * 基于应用配置数据库的虚拟文件系统
 * @param {string} base - 根路径约束（如 "sessions"）
 * @param {AiChat.Mount} options
 * @returns {Promise<AiChat.FileSystemInstance>}
 */
export const createConfigFileSystem = async (base, options) => createWebFileSystem(await resolveDirectory(configFS_root, base || ""), options);
