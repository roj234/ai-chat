import {
	deleteConversation,
	getKV,
	getMessages,
	kvListDel,
	kvListGet,
	kvListGetKeys,
	kvListSet,
	setKV,
	updateConversation
} from "/src/database.js";
import {config, conversations, selectedConversation} from "/src/states.js";
import {createWebFileSystem, resolveDirectory} from "./WebFileSystem.js";
import {$update, unconscious} from "unconscious";
import {NestedMap, NODE_VALUE} from "unconscious/common/NestedMap.js";
import {serializeJSON} from "/src/utils/marshal.js";
import {DI_settings} from "/src/hooks.js";

/**
 * 角色名：
 * 种族：
 * 年龄：
 * 性别：
 * 身份/表现/成就：
 * 性格：
 * 外貌/外观：
 * 人物关系：
 * 背景：
 * 其他(如能力等，没有可不填)
 */
// TODO server 重建数据库也重建一下id

const BLACKLIST_CHARS = new RegExp('[| &=?#{}<>:,]', 'g');
const SOME = {};

class FakeFile {
	kind = "file";
	text;
	constructor(fs, path) {
		this.fs = fs;
		this.path = path;
	}

	async _text() {
		let text = this.text;
		if (text == null) {
			text = this.text = await this.fs.read(this.path);
		}
		return text;
	}

	async createWritable({ keepExistingData } = SOME) {
		let text = keepExistingData ? await this._text() : '';
		return {
			write(data) {text += data;},
			close: async () => {
				await this.fs.write(this.path, text);
				this.text = text;
			}
		}
	}
	async getFile() {
		const text = await this._text()
		const time = Date.now();
		return new File([text], "unknown");
	}
}

class FakeDirectory {
	kind = "directory";
	/**
	 *
	 * @param {NestedMap<string, Function>} fs
	 * @param {string[]} path
	 * @param children=
	 */
	constructor(fs, path, children) {
		this.fs = fs;
		this.path = path;
		this.children = children || fs.getChildren(path);
	}

	async *entries() {
		const children = this.children;
		const hook = children.get(NODE_VALUE);
		if (hook) {
			yield * (await (await (hook.handle || hook)).entries(this));
			return;
		}

		for (let [name, val] of children) {
			const joinedKey = [...this.path, name];
			const hook = val.get(NODE_VALUE);

			yield [name, hook?.read ? new FakeFile(hook, joinedKey) : new FakeDirectory(this.fs, joinedKey, val)];
		}
	}

	getDirectoryHandle(name, { create } = SOME) {
		const children = this.children;
		const entries = children.get(name);
		let hook;
		if (entries?.size && !(hook = entries.get(NODE_VALUE))?.read) {
			return hook?.handle || new FakeDirectory(this.fs, [...this.path, name], entries);
		}

		hook = children.get(NODE_VALUE)?.dir(name, create, this);
		if (hook) return hook;

		if (create) throw "Creating directory is not supported on current parent";
		throw 'Not exist or not directory';
	}

	getFileHandle(name, { create } = SOME) {
		const children = this.children;
		const handle = children.get(name)?.get(NODE_VALUE);
		if (handle?.read) {
			return new FakeFile(handle, [...this.path, name]);
		}

		const hook = children.get(NODE_VALUE)?.file(name, create, this);
		if (hook) return hook;

		if (create) throw "Creating file is not supported on current parent";
		throw 'Not exist or not file';
	}

	removeEntry(name, options, { recursive } = SOME) {
		const hook = this.children.get(NODE_VALUE)?.del;
		if (hook) return hook(name, recursive, this);
		throw "Not supported";
	}
}

const FAKE_DIR_CONSTANT = { type: "directory" };
const FAKE_FILE_CONSTANT = {
	kind: "file",
	getFile() {
		return {
			size: "unknown",
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

const registry = new NestedMap();

const kvTypes = ["memories"];
const kvsTypes = ["st|char", "st|preset", "st|lorebook"];

const kvHandler = {
	read: async (type) => serializeJSON(await getKV(type), 2),
	write: (type, value) => setKV(type, JSON.parse(value))
};

registry.set([".", "kv"], {
	file(name, create) {
		const path = checkJson(name);
		if (kvTypes.includes(path))
			return new FakeFile(kvHandler, decodeURI(path));
	},
	*entries() {
		for (const type of kvTypes) {
			yield [type+".json", FAKE_FILE_CONSTANT];
		}
	}
});

const kvsHandler = {
	read: async ([type, name]) => serializeJSON(await kvListGet(type, name), 2),
	write: ([type, name], value) => kvListSet(JSON.parse(value), type, name)
};
for (const type of kvsTypes) {
	const handler = {
		file(name, create) {
			return new FakeFile(kvsHandler, [type, checkJson(name)]);
		},
		/**
		 *
		 * @param {string[]} path
		 * @param {NestedMap<string, Function>} fs
		 * @returns {Generator<[string, FakeDirectory | FakeFile], void, *>}
		 */
		async *entries(path, fs) {
			const keys = await kvListGetKeys(type);
			for (const {name} of keys) {
				yield [name+".json", FAKE_FILE_CONSTANT];
			}
		},
		del(name) {
			return kvListDel(type, name);
		}
	};

	//registry.set([".", "kvs", type], handler);
	registry.set([".", "kvs", fileEscape(type)], handler);
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
	async read([conv, id]) {
		const msgs = await getMessages(conv);
		const msg = msgs.find(m => m.id === id);
		if (!msg) throw (`Message ${id} not found`);
		return serializeJSON(msg, 2);
	},
	async write([conv, id], data) {
		const msgs = await getMessages(conv);
		const index = msgs.findIndex(m => m.id === id);
		if (index < 0) throw (`Message ${id} not found`);
		msgs[index] = JSON.parse(data);
		await updateConversation(conv, msgs);
	},
}


registry.set([".", "conversations", 0, "messages"], {
	file(name, create, self) {
		const conv = self.path.at(-2);
		return new FakeFile(convMessageHandler, [conv, parseInt(checkJson(name), 10)]);
	},
	async *entries(self) {
		const conv = self.path.at(-2);
		for (const message of await getMessages(conv)) {
			yield [message.id+".json", FAKE_FILE_CONSTANT];
		}
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
registry.set([".", "conversations", 0], {
	async file(name, create, self) {
		if (name === "conversation.json") {
			const conv = self.path.at(-1);
			return new FakeFile(convHandler, conv);
		}
	},
	dir(name, create, self) {
		if (name === "messages") {
			const conv = self.path.at(-1);
			return new FakeDirectory(registry, [".", "conversations", conv, name], registry.getChildren([".", "conversations", 0, name]));
		}
	},
	*entries(self) {
		yield ["conversation.json", FAKE_FILE_CONSTANT];
		yield ["messages", this.dir("messages", false, self)];
	}
});

registry.set([".", "conversations"], {
	dir(name, create) {
		const id = parseInt(name, 10);
		if (id === selectedConversation.id) throw "Not allowed: modifying ACTIVE conversation will cause data loss";

		const conv = unconscious(conversations).find(c => c.id === id);
		if (conv) return new FakeDirectory(registry, [".", "conversations", conv], registry.getChildren([".", "conversations", 0]));
	},
	*entries() {
		for (const {id} of unconscious(conversations)) {
			yield [String(id), FAKE_DIR_CONSTANT];
		}
	},
	async del(name) {
		const id = parseInt(name, 10);
		const idx = unconscious(conversations).findIndex(c => c.id === id);
		if (idx < 0) throw 'Not exist';
		const conv = conversations.splice(idx, 1)[0];
		return deleteConversation(conv);
	}
});

const tempHandle = {};
Object.defineProperty(tempHandle, "handle", {
	get: async () => (await resolveDirectory(await navigator.storage.getDirectory(), "tmp/c"+selectedConversation.id, { create: true }))
});
registry.set([".", "tmp"], tempHandle);

registry.set([".", "config.json"], {
	read(name) {
		const {endpoint, accessToken, db_server, db_pat, ...val} = unconscious(config);
		return JSON.stringify(val, null, 2);
	},
	write(name, data) {
		const {endpoint, model, accessToken, db_server, db_pat} = unconscious(config);
		config.value = JSON.parse(data);
		config.endpoint = endpoint;
		config.accessToken = accessToken;
		config.db_server = db_server;
		config.db_pat = db_pat;
		DI_settings.sync();
	},
});

const root = new FakeDirectory(registry, ["."]);

/**
 * 基于应用配置数据库的虚拟文件系统
 * @param {string} base - 根路径约束（如 "conversations"）
 * @returns {AiChat.FileSystemInstance}
 */
export async function createVirtualFileSystem(base) {
	return createWebFileSystem(await resolveDirectory(root, base || ""));
}
