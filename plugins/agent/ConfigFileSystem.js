import {serializeJSON} from "/src/utils/serialization.js";
import {
	getMessages,
	kvListDel,
	kvListGet,
	kvListGetKeys,
	kvListSet,
	markMessageDirty,
	updateConversation
} from "/src/database.js";
import {conversations, findConversation, LOCKED, selectedConversation} from "/src/states.js";
import {VirtualDirectory, VirtualFile} from "./VirtualFileSystem.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {createWebFileSystem} from "./WebFSDriver.js";
import {resolveDirectory} from "./WebFSUtils.js";
import {$update, unconscious} from "unconscious";
import {FSE_AccessDenied, FSE_NotFound, throwDOMException} from "../../common/pure-utils.js";

const BLACKLIST_CHARS = new RegExp('[| &=?#{}<>:,]', 'g');

const FAKE_DIR_CONSTANT = { kind: "directory" };
const FAKE_FILE_CONSTANT = {
	kind: "file",
	getFile() {
		return {
			size: -1,
			lastModified: 0
		}
	}
};

/**
 * 对路径字符串中的「非法字符」进行 URI 转义
 * @param {string} str - 原始路径字符串
 * @returns {string} 转义后的路径字符串（仅黑名单字符被编码）
 */
const fileEscape = (str) => str.replaceAll(BLACKLIST_CHARS, encodeURI);

/** 校验并剥离 .json 后缀 */
const checkJson = (name) => {
	if (!name.endsWith(".json")) throw (`Invalid file name: ${name}`);
	return name.slice(0, -5);
};

const CFG_ROOTS = new NestedMap();

const kvsTypes = ["st|char", "st|preset", "st|lorebook", "preset"];

const kvsHandler = {
	read: async ([type, name]) => serializeJSON(await kvListGet(type, name), 2),
	write: ([type, name], value) => kvListSet(JSON.parse(value), type, name)
};

CFG_ROOTS.set([".handlers", 0], {
	file(name, create, self) {
		const type = self.path.at(-2);
		return new VirtualFile(kvsHandler, [type, self.path.at(-1)]);
	},
	async *entries() {
		yield ["data.json", FAKE_FILE_CONSTANT];
	}
});

for (const type of kvsTypes) {
	const handler = {
		dir(name) {
			return new VirtualDirectory(CFG_ROOTS, [".", "kvs", type, name], CFG_ROOTS.getChildren([".handlers", 0]));
		},
		/**
		 *
		 * @param {string[]} path
		 * @param {NestedMap<string, Function>} fs
		 * @returns {Generator<[string, VirtualDirectory | VirtualFile], void, *>}
		 */
		async *entries(path, fs) {
			const keys = await kvListGetKeys(type);
			for (const {name} of keys) {
				yield [name, this.dir(name)];
			}
		},
		del(name) {
			return kvListDel(type, name);
		}
	};

	CFG_ROOTS.set([".", "kvs", fileEscape(type)], handler);
}

const convHandler = {
	async read(convObj) {
		await getMessages(convObj);
		return serializeJSON(convObj, 2);
	},
	async write(convObj, data) {
		const meta = JSON.parse(data);
		Object.assign(convObj, meta);
		await updateConversation(convObj);
		$update(conversations);
	},
};

/** 为指定对话 id 创建 messages 处理器 */
const convMessageHandler = {
	async read([conv, msgs, id]) {
		if (id < 0) return "<write-only sink>";
		return serializeJSON(msgs[id], 2);
	},
	async write([conv, msgs, index], data) {
		const obj = JSON.parse(data);
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
}


CFG_ROOTS.set([".handlers", 1], {
	async file(name, create, self) {
		const conv = self.path.at(-2);
		const msgs = await getMessages(conv);

		if (name === 'insert') {
			if (create) return new VirtualFile(convMessageHandler, [conv, msgs, -1]);
			throwDOMException(`This is a write-only sink`, FSE_NotFound);
		}

		const id =  parseInt(checkJson(name), 10);
		const index = msgs.findIndex(m => m.id === id);
		if (index < 0) throwDOMException(`Message #${id}`, FSE_NotFound);

		return new VirtualFile(convMessageHandler, [conv, msgs, index]);
	},
	async *entries(self) {
		const conv = self.path.at(-2);
		for (const message of await getMessages(conv)) {
			yield [message.id+".json", FAKE_FILE_CONSTANT];
		}
		yield ["insert", FAKE_FILE_CONSTANT];
	},
	async del(name, recursive, self) {
		const conv = self.path.at(-2);
		const id = parseInt(checkJson(name), 10);

		const msgs = await getMessages(conv);
		const index = msgs.findIndex(m => m.id === id);
		if (index < 0) throw (`Message ${id} not found`);
		msgs.splice(index, 1);
		await updateConversation(conv, msgs, 1);
	}
});
CFG_ROOTS.set([".handlers", 2], {
	async file(name, create, self) {
		if (name === "session.json") {
			const conv = self.path.at(-1);
			return new VirtualFile(convHandler, conv);
		}
	},
	dir(name, create, self) {
		if (name === "messages") {
			const conv = self.path.at(-1);
			return new VirtualDirectory(CFG_ROOTS, [".", "sessions", conv, name], CFG_ROOTS.getChildren([".handlers", 1]));
		}
	},
	*entries(self) {
		yield ["session.json", FAKE_FILE_CONSTANT];
		yield ["messages", this.dir("messages", false, self)];
	}
});

CFG_ROOTS.set([".", "sessions"], {
	dir(name, create) {
		const id = parseInt(name, 10);
		const conv = findConversation(id);
		if (conv) {
			if (id === selectedConversation.id || conv[LOCKED]) throw new DOMException("This conversation is opening", "ReadOnlyError");
			return new VirtualDirectory(CFG_ROOTS, [".", "sessions", conv], CFG_ROOTS.getChildren([".handlers", 2]));
		}
	},
	*entries() {
		for (const {id} of unconscious(conversations)) {
			yield [String(id), FAKE_DIR_CONSTANT];
		}
	}
});

const configFS_root = new VirtualDirectory(CFG_ROOTS);

/**
 * 基于应用配置数据库的虚拟文件系统
 * @param {string} base - 根路径约束（如 "sessions"）
 * @param {AiChat.Mount} options
 * @returns {Promise<AiChat.FileSystemInstance>}
 */
export const createConfigFileSystem = async (base, options) => createWebFileSystem(await resolveDirectory(configFS_root, base || ""), options);
