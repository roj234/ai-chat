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
import {config, conversations} from "/src/states.js";
import {createHashLine} from "/common/hash-line.js";
import {normalizePath} from "./WebFileSystem.js";
import {unconscious} from "unconscious";

const BLACKLIST_CHARS = new RegExp('[| &=?#{}<>:,]', 'g');

/**
 * 对路径字符串中的「非法字符」进行 URI 转义
 *
 * @param {string} str - 原始路径字符串
 * @returns {string} 转义后的路径字符串（仅黑名单字符被编码）
 */
const fileEscape = (str) => str.replaceAll(BLACKLIST_CHARS, encodeURI);

/**
 * 基于应用配置数据库的虚拟文件系统
 * @returns {AiChat.FileSystemInstance}
 */
export function createConfigFileSystem(base) {
	const tmp = new Map;
	const basePath = normalizePath(base);
	const myParse = (path) => {
		const arr = normalizePath(decodeURI(path));
		if (arr[0] === 'tmp') return arr;

		if (arr.length < basePath.length) throw "Permission denied (path must start from: " + fileEscape(basePath.join('/')) + ")";
		for (let i = 0; i < basePath.length; i++) {
			if (arr[i] !== basePath[i]) throw "Permission denied (path must start from: " + fileEscape(basePath.join('/')) + ")";
		}
		return arr;
	}
	const kv = ["memories"].map(fileEscape);
	const kvs = ["st|char", "st|preset", "st|lorebook"].map(fileEscape);

	/** 校验并剥离 .json 后缀 */
	const checkJson = (name) => {
		if (!name.endsWith(".json")) throw new Error(`Invalid file name: ${name}`);
		return name.slice(0, -5);
	};

	/** 安全解析 JSON 字符串 */
	const parseJson = (data, path) => {
		try { return JSON.parse(data); }
		catch (e) { throw new Error(`Invalid JSON at ${path}: ${e.message}`); }
	};

	/** 查找对话，不存在则抛错 */
	const findConv = (id) => {
		const conv = (conversations || []).find(c => c.id === id);
		if (!conv) throw new Error(`Conversation ${id} not found`);
		return conv;
	};

	const api = {
		async read_image({ path }) {
			return "read_image() is not available in ConfigFileSystem";
		},
		async mkdirs({ path }) {
			return "mkdirs() is not available in ConfigFileSystem (you may only use existing directories)";
		},
		async copy({ src, dest, move }) {
			return "copy() is not available in ConfigFileSystem";
		},
		async stat({ path }) {
			return "stat() is not available in ConfigFileSystem";
		},

		/** 删除文件 / 对话 */
		async delete({ path }) {
			const arr = myParse(path);
			switch (arr[0]) {
				case "tmp":
					if (arr.length === 2) {
						return tmp.delete(arr[1]);
					}
				break;
				case "kv":
					if (arr.length === 2) {
						await setKV(checkJson(arr[1]), undefined);
						return;
					}
				break;
				case "kvs":
					if (arr.length === 3) {
						await kvListDel(arr[1], checkJson(arr[2]));
						return;
					}
				break;
				case "conversations":
					if (arr.length === 2) {
						// conversations/{id} — 直接删对话，id 不加 .json 后缀
						await deleteConversation({ id: parseInt(arr[1], 10) });
						return;
					} else if (arr.length === 4 && arr[2] === "messages") {
						throw new Error(`deleteMessage(${checkJson(arr[3])}) is not implemented`);
					}
				break;
			}
			throw new Error(`Cannot delete '${path}'`);
		},

		/** 列出目录内容（TSV 格式） */
		async list({ path, glob: globStr }) {
			if (globStr) throw new Error("glob filter is not available in ConfigFileSystem");

			let entries = null;
			const arr = normalizePath(decodeURI(path));

			switch (arr.length) {
				case 0:
					// 虚拟根目录
					entries = [
						'tmp\tdir',
						'kv\tdir',
						'kvs\tdir',
						'conversations\tdir',
						'config.json\tfile'
					];
					break;
				case 1:
					switch (arr[0]) {
						case "tmp":
							entries = [...tmp.keys()].map(item => item+"\tfile");
						break;
						case "kv":
							entries = kv.map(item => item + ".json\tfile");
							break;
						case "kvs":
							entries = kvs.map(item => item + "\tdir");
							break;
						case "conversations":
							entries = (conversations || []).map(c => `${c.id}\tdir`);
							break;
					}
					break;
				case 2:
					switch (arr[0]) {
						case "kvs":
							entries = (await kvListGetKeys(arr[1]))
								.map(item => item.name + ".json\tfile");
							break;
						case "conversations":
							entries = ['meta.json\tfile', 'messages\tdir'];
							break;
					}
					break;
				case 3:
					if (arr[0] === "conversations" && arr[2] === "messages") {
						const msgs = await getMessages({ id: parseInt(arr[1]) });
						entries = msgs.map(m => m.id + ".json\tfile");
					}
					break;
			}

			return entries?.length ? entries.map(fileEscape).join("\n") : "[No result]";
		}
	};

	return {
		...api,
		...createHashLine({
			/**
			 * 读取文件内容（JSON 字符串）
			 * @param {string} path
			 * @returns {Promise<string>}
			 */
			async read(path) {
				const arr = myParse(path);

				switch (arr[0]) {
					case "tmp":
						if (arr.length === 1) {
							const str = tmp.get(arr[1]);
							if (str != null) return str;
						}
					break;

					// ——— kv/{name}.json ———
					case "kv":
						if (arr.length === 2) {
							const val = await getKV(checkJson(arr[1]));
							return JSON.stringify(val, null, 2);
						}
						break;

					// ——— kvs/{type}/{name}.json ———
					case "kvs":
						if (arr.length === 3) {
							const val = await kvListGet(arr[1], checkJson(arr[2]));
							return JSON.stringify(val, null, 2);
						}
						break;

					// ——— conversations/{id}/meta.json | conversations/{id}/messages/{msgId}.json ———
					case "conversations":
						if (arr.length === 3 && arr[2] === "meta.json") {
							const conv = findConv(parseInt(arr[1]));
							return JSON.stringify(conv, null, 2);
						}
						if (arr.length === 4 && arr[2] === "messages") {
							const msgs = await getMessages({ id: parseInt(arr[1]) });
							const msg = msgs.find(m => String(m.id) === checkJson(arr[3]));
							if (!msg) throw new Error(`Message ${arr[3]} not found`);
							return JSON.stringify(msg, null, 2);
						}
						break;

					// ——— 根目录 config.json ———
					case "config.json":
						if (arr.length === 1) {
							const {endpoint, /*model, */accessToken, db_server, db_pat, ...val} = unconscious(config);
							return JSON.stringify(val, null, 2);
						}
						break;
				}

				throw new Error(`File not exist: '${path}'`);
			},

			/**
			 * 写入 JSON 数据到文件
			 * @param {string} path
			 * @param {string} data - JSON 字符串
			 * @returns {Promise<void>}
			 */
			async write(path, data) {
				const arr = myParse(path);
				if (arr[0] !== 'tmp' && config.incognito) throw "Readonly filesystem";

				switch (arr[0]) {
					case "tmp":
						if (arr.length === 2) {
							tmp.set(arr[1], data);
							return;
						}
						break;
					case "kv":
						if (arr.length === 2) {
							await setKV(checkJson(arr[1]), parseJson(data, path));
							return;
						}
						break;

					case "kvs":
						if (arr.length === 3) {
							await kvListSet(parseJson(data, path), arr[1], checkJson(arr[2]));
							return;
						}
						break;

					case "conversations":
						if (arr.length === 3 && arr[2] === "meta.json") {
							const meta = parseJson(data, path);
							const conv = findConv(parseInt(arr[1]));
							await updateConversation({ ...conv, ...meta });
							return;
						}
						if (arr.length === 4 && arr[2] === "messages") {
							const patch = parseJson(data, path);
							const conv = findConv(parseInt(arr[1]));
							const msgs = await getMessages({ id: conv.id });
							const idx = msgs.findIndex(m => String(m.id) === checkJson(arr[3]));
							if (idx === -1) throw new Error(`Message ${arr[3]} not found`);
							msgs[idx] = { ...msgs[idx], ...patch };
							await updateConversation(conv, msgs);
							return;
						}
						break;

					case "config.json":
						if (arr.length === 1) {
							const {endpoint, model, accessToken, db_server, db_pat} = unconscious(config);
							config.value = parseJson(data, path);
							config.endpoint = endpoint;
							//config.model = model;
							config.accessToken = accessToken;
							config.db_server = db_server;
							config.db_pat = db_pat;
							//await setKV("config", parseJson(data, path));
							return;
						}
						break;
				}

				throw new Error(`Cannot write to '${path}'`);
			},

			/**
			 * 文件修改时间（虚拟 FS 无真实 mtime，返回当前时间）
			 * @returns {Promise<number>}
			 */
			async mtime(path) {
				return Date.now();
			}
		})
	};
}