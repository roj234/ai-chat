import {config, conversations, messages, selectedConversation} from "./states.js";
import {showToast} from "./components/Toast.js";
import {
	deleteDatabase,
	getMessagesCacheFirst,
	isIDB,
	kvListGetValues,
	kvListSet,
	updateConversation
} from "./database.js";
import {downloadFile, prettyError} from "./utils/utils.js";
import SimpleModal from "./components/SimpleModal.jsx";
import {ZipReader, ZipWriter} from "unconscious/common/zip-io.js";
import {$computed, $state, $update, unconscious} from "unconscious";
import {decodeObjects, serializeJSON} from "./utils/marshal.js";
import {SETTINGS} from "./settings.js";
import {DI_settings} from "./hooks.js";
import {createJsonParser} from "unconscious/common/Json.js";

const sleep = () => new Promise(resolve => setTimeout(resolve));

/**
 *
 * @param {Partial<AiChat.Conversation>} conv
 * @param {AiChat.Message[]} messages_
 * @param {boolean=false} batch
 * @return {Promise<AiChat.Conversation>}
 */
export const importConversationData = async (conv, messages_, batch) => {
	delete conv.id;
	if (!Number.isFinite(conv.time)) conv.time = Date.now();
	if (typeof conv.title !== "string") conv.title = "";

	if (messages_) {
		messages_.forEach(message => {
			delete message.id;
		});
	}

	await updateConversation(conv, messages_, true);
	if (!batch) {
		conv.ready = true;
		conversations.unshift(conv);
		selectedConversation.value = conv;
		messages.value = messages_;
	}
	return conv;
};

const loadBackupZip = async file => {
	const zipFile = await ZipReader(file);

	const data = parseInt(await zipFile.getText(APP_NAME));
	if (data !== 1 && data !== 2) {
		if (!confirm("导入的文件格式可能有误，是否继续？")) {
			return;
		}
	}

	config.incognito = 0;

	const kvList = await zipFile.getText("kvList.json");
	if (kvList) {
		const promises = [];
		for (const item of JSON.parse(kvList)) {
			promises.push(decodeObjects(item, null).then(() => kvListSet(item, item.type)));
		}
		await Promise.all(promises);
		showToast('导入了KV列表，可能需要刷新网页');
	}

	const message = $state("导入中");
	const close = showToast(message, '', 0);

	const new_convs = [];
	const promises = [];
	let size = 0;
	for (const [name] of zipFile.entries()) {
		if (name.startsWith("conversations/") && name.endsWith(".json")) {
			promises.push(zipFile.getText(name).then(async (text) => {
				if (size + text.length > 1048576) {
					await sleep();
					size = 0;
				}
				size += text.length;

				const jsonl = parseJSONLine(await file.text());
				let conv, msg;
				await decodeObjects(jsonl, zipFile);
				if (jsonl.length > 1) {
					conv = jsonl.pop();
					msg = jsonl;
				} else {
					conv = jsonl[0];
					msg = conv.messages;
					delete conv.messages;
				}

				new_convs.push(await importConversationData(conv, msg, true));
			}).catch(e => {
				showToast(name+": 导入失败\n"+prettyError(e), 'error');
			}));
		}
	}
	await Promise.all(promises);

	if (new_convs.length) {
		conversations.unshift(...new_convs);
		conversations.sort((a, b) => b.time - a.time);
		message.value = "导入 "+new_convs.length+" 条对话";
	} else {
		message.value = "无对话数据";
	}
	setTimeout(close, 3000);

	const preset = await zipFile.getText("config.json");
	if (preset) {
		const data = JSON.parse(preset);
		await decodeObjects(data, null);
		Object.assign(unconscious(config), data);
		$update(config);
		DI_settings.sync();
		showToast('配置已导入');
	}
};

/**
 * @type {Record<string, (function(Object, boolean, string): Promise<void> | false)[]>}
 */
const dataImportHandlers = {};

/**
 *
 * @param {string | "application/json"} type
 * @param {function(jsonData: Object, batch: boolean, fileName: string): Promise<void> | false} callback
 */
export const registerDataImportHandler = (type, callback) => {
	const dataImportHandler = dataImportHandlers[type];
	if (dataImportHandler) dataImportHandler.push(callback);
	else dataImportHandlers[type] = [callback];
};

export const importConversation = async e => {
	const files = Array.from(e.target.files);
	e.target.value = '';

	loop:
	for (/** @type {File} */const file of files) {
		let obj = file;
		let err;
		try {
			if (file.type.endsWith("/zip")) {
				await loadBackupZip(file, e);
				continue;
			} else if (file.type === "application/json") {
				const jsonl = parseJSONLine(await file.text());
				await decodeObjects(jsonl, null);
				if (jsonl.length > 1 && jsonl.at(-1).id === APP_NAME) {
					await importConversationData(jsonl.pop(), jsonl, files.length > 1);
					continue;
				} else {
					obj = jsonl[0];

					if (typeof obj.title === "string" && obj.messages?.length) {
						const { messages, ...rest } = obj;
						await importConversationData(rest, messages, files.length > 1);
						continue;
					}
				}
			}

			for (let fn of dataImportHandlers[file.type] || []) {
				const promise = fn(obj, files.length > 1, file.name);
				if (promise && await promise)
					continue loop;
			}

			err = file.name+": 不支持的文件格式";
		} catch (e) {
			console.error(e);
			err = '导入失败: ' + prettyError(e);
		}
		showToast(err, 'error');

		if (files.length > 1) $update(conversations);
	}
};

export const duplicateConversation = async () => {
	const conv = unconscious(selectedConversation);
	if (!conv?.ready) {
		showToast('无对话选中', 'error');
		return;
	}
	conv.title += ' 另存 '+new Date().toISOString();

	await importConversationData(structuredClone(conv), structuredClone(unconscious(messages).filter(item => item.id >= 0)));

	showToast('已将当前对话另存为', 'ok');
};

/**
 *
 * @param {number} type
 * @param _conv
 * @return {Promise<void>}
 */
export const exportConversation = async (type, _conv) => {
	const zw = ZipWriter();
	await zw.add(APP_NAME, "2");

	if (type&1) {
		const conv = _conv || unconscious(selectedConversation);
		if (conv && type === 1) {
			const jsonData = await serializeToJSONLine(conv, zw);
			if (zw.fileCount() === 1) {
				downloadFile(new File([jsonData], conv.title?conv.title+".json":"", { type: "application/json" }), "json");
				return;
			}

			await zw.add("conversations/0.json", jsonData, {
				lastModified: conv.time,
				compression: true
			});
		} else {
			const successed = $state(0);
			const conversations1 = unconscious(conversations);
			let close = showToast($computed(() => '已导出 '+unconscious(successed)+'/'+conversations1.length+' 条数据…'), '', 0);

			const callbacks = [];
			for (let i = 0; i < conversations1.length; i++) {
				const conv = conversations1[i];
				const reversedIndex = conversations1.length - 1 - i;

				if (((i+1) & 15) === 0) await sleep();

				callbacks.push(serializeToJSONLine(conv, zw).then(text => {
					successed.value ++;
					return zw.add(`conversations/${reversedIndex}.json`, text, {
						lastModified: conv.time,
						compression: true
					});
				}));
			}

			await Promise.all(callbacks);
			close();
		}
	}
	if (type&2) {
		const compression = {compression: true};

		await zw.add("config.json", JSON.stringify(config), compression);

		const kvList = await kvListGetValues(type&4 ? "*" : "preset");
		const jsonData = await serializeJSON(kvList, 0, zw);

		await zw.add("kvList.json", jsonData, compression);
	}

	try {
		downloadFile(zw.finish(), "zip");
	} catch (e) {
		console.error(e);
		showToast('导出失败: ' + prettyError(e), 'error');
	}
};


const cleanMessages = messages => messages.map(({id, ...rest}) => id < 0 ? null : rest).filter(Boolean);

const serializeToJSONLine = async (conv, zw) => {
	const { id: _a, ready: _b, ...stripped } = conv;
	stripped.id = APP_NAME;
	const messages = cleanMessages(await getMessagesCacheFirst(conv));

	let jsonData = await serializeJSON(stripped, 0, zw);
	for (const message of messages) {
		jsonData += '\n' + await serializeJSON(message, 0, zw);
	}
	return jsonData;
};

const parseJSONLine = (str) => {
	let conversation;
	let messages = [];

	const jp = createJsonParser((path, value, is_partial) => {
		if (!path.length) {
			if (!conversation) conversation = value;
			else messages.push(value);
		}
	}, {
		json5: true,
		jsonl: true
	});
	jp.write(str);
	jp.end();

	messages.push(conversation);
	return messages;
};

SETTINGS.push(
	{
		type: "element",
		_tab: ["general", "data"],
		_id: "import",
		_order: -3,
		name: "导入对话、预设、备份及更多格式",
		element: <div className={"choice-scroll"}>
			<label className="btn ghost">导入
				<input type="file" accept="application/zip,application/json,image/png" style="display:none;" multiple onChange={importConversation}/>
			</label>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		_order: -2,
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => exportConversation(1)}>备份对话</button>
			<button className="btn ghost" onClick={() => exportConversation(2)}>备份预设</button>
			<button className="btn ghost" onClick={() => exportConversation(7)}>备份所有</button>
		</div>
	},
	{
		_id: "dd",
		type: "element",
		_tab: "data",
		_order: -1,
		name: "数据调试",
		element: <div className={"choice-scroll"}>
			<button className="btn danger" onClick={() => {
				SimpleModal({
					message: isIDB ? '删除所有数据（对话、预设、历史记录）？' : '重建后端数据库（压缩），有可能出现问题，请备份',
					accent: 'danger',
					onConfirm() {
						deleteDatabase().then(() => {
							location.reload();
						})
					}
				});
			}}>删库</button>
		</div>
	},
);
