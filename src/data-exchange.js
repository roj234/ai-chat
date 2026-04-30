import {config, conversations, messages, selectedConversation, Shared} from "./states.js";
import {showToast} from "./components/Toast.js";
import {
	CONVERSATION_KEYS,
	deleteDatabase,
	getMessages,
	kvListGetValues,
	kvListSet,
	newConversation,
	updateConversation
} from "./database.js";
import {prettyError} from "./utils/utils.js";
import {runAllTools} from "./skills.js";
import SimpleModal from "./components/SimpleModal.jsx";
import {openZip, ZipWriter} from "../vendor/jszip.js";
import {$computed, $state, $update} from "unconscious";
import {reloadPresetList} from "./components/PresetDropdown.jsx";
import {decodeObjects, encodeObjects} from "./utils/marshal.js";

/**
 *
 * @param {Partial<AiChat.Conversation> & {messages: AiChat.Message[]}} convData
 * @param {boolean=false} batch
 * @return {Promise<AiChat.Conversation>}
 */
export async function importConversationData({messages: messages_, ...rest}, batch) {
	const newConv = await newConversation();
	for (const name of CONVERSATION_KEYS) {
		if (name !== "id" && name in rest) newConv[name] = rest[name];
	}

	if (messages_) {
		messages_.forEach(message => {
			delete message.id;
		});
		runAllTools(newConv, messages_, true);
	}

	await updateConversation(newConv, messages_);
	if (!batch) {
		newConv.ready = true;
		conversations.unshift(newConv);
		selectedConversation.value = newConv;
		messages.value = messages_;
	}
	return newConv;
}

async function loadBackupZip(file) {
	const zipFile = await openZip(file);

	const data = await zipFile.getText(APP_NAME);
	if (data !== '1') {
		if (!confirm("导入的文件格式可能有误，是否继续？")) {
			return;
		}
	}

	config.debugDatabase = 0;

	const presets = await zipFile.getText("presets.json");
	if (presets) {
		for (const preset of JSON.parse(presets)) {
			await decodeObjects(preset, null);
			await kvListSet(preset, "preset");
		}
		reloadPresetList();
		showToast('预设已导入');
	}

	const message = $state("导入中");
	const close = showToast(message, '', 0);

	const new_convs = [];
	for (const [name] of zipFile.entries()) {
		if (name.startsWith("conversations/") && name.endsWith(".json")) {
			message.value = "正在导入 "+name;
			try {
				const conv = JSON.parse(await zipFile.getText(name));
				await decodeObjects(conv, zipFile);
				new_convs.push(await importConversationData(conv, true));
			} catch (e) {
				showToast(name+": 导入失败\n"+prettyError(e), 'error');
			}
		}
	}

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
		Object.assign(config.value, data);
		$update(config);
		Shared.SettingUI.onSettingsUpdated();
		showToast('配置已导入');
	}
}

/**
 * @type {Record<string, (function(Object, boolean, string): Promise<void> | false)[]>}
 */
const dataImportHandlers = {};

/**
 *
 * @param {string | "application/json"} type
 * @param {function(jsonData: Object, batch: boolean, fileName: string): Promise<void> | false} callback
 */
export function registerDataImportHandler(type, callback) {
	const dataImportHandler = dataImportHandlers[type];
	if (dataImportHandler) dataImportHandler.push(callback);
	else dataImportHandlers[type] = [callback];
}

export async function importConversation(e) {
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
				const jsonData = JSON.parse(await file.text());
				await decodeObjects(jsonData, null);
				if (typeof jsonData.title === "string" && jsonData.messages?.length) {
					await importConversationData(jsonData, files.length > 1);
					continue;
				} else {
					obj = jsonData;
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
}

export async function duplicateConversation() {
	const conv = selectedConversation.value;
	if (!conv?.ready) {
		showToast('无对话选中', 'error');
		return;
	}

	await importConversationData({
		...conv,
		messages: messages.value
	});

	showToast('已将当前对话另存为', 'ok');
}

function cleanMessages(messages) {
	for (const message of messages) delete message.id;
	return messages;
}

export async function exportConversation(isConfig, _conv) {
	const mapping = new Map;
	const replacer = (_, value) => {
		return mapping.get(value) ?? value;
	};

	const zw = ZipWriter();
	await zw.add(APP_NAME, "1");

	let data;

	if (isConfig) {
		await zw.add("config.json", JSON.stringify(config.value), {
			compress: true
		});
		await zw.add("presets.json", JSON.stringify((await kvListGetValues("preset")).map(item => {
			delete item.id;
			delete item.type;
			return item;
		})), {
			compress: true
		});
	} else {
		const conv = _conv || selectedConversation.value;
		if (conv) {
			data = {
				//spec: "roj234:aichat:conversation",
				title: conv.title,
				time: conv.time,
				messages: cleanMessages(/*messages.value || */await getMessages(conv))
			};
			await encodeObjects(data.messages, mapping, zw);

			const jsonData = JSON.stringify(data, replacer, 2);
			if (zw.fileCount() === 1) {
				downloadFile(new Blob([jsonData], { type: "application/json" }), "json");
				return;
			}

			await zw.add("conversations/0.json", jsonData, {
				timestamp: data.time,
				compress: true
			});
		} else {
			const successed = $state(0);
			let close = showToast($computed(() => '已导出 '+successed.value+'/'+conversations.length+' 条数据…'), '', 0);

			const callbacks = [];
			const my_conversations = [];
			for (const conv of conversations) {
				const index = callbacks.length;

				const copy = {...conv};
				delete copy.id;

				callbacks.push(getMessages(conv).then(messages => {
					copy.messages = cleanMessages(messages);
					my_conversations[index] = copy;
					return encodeObjects(messages, mapping, zw).then(() => {
						successed.value ++;
					});
				}));
			}

			await Promise.all(callbacks);
			close();

			close = showToast($computed(() => '已压缩 '+successed.value+'/'+conversations.length+' 条数据…'), '', 0);

			my_conversations.sort((a, b) => a.time - b.time);
			for (let i = 0; i < my_conversations.length; i++) {
				successed.value = i;

				const conv = my_conversations[i];
				await zw.add(`conversations/${i}.json`, JSON.stringify(conv, replacer), {
					timestamp: conv.time,
					compress: true
				});
			}

			setTimeout(close, 3000);
		}
	}

	try {
		downloadFile(zw.finish(), "zip");
	} catch (e) {
		console.error(e);
		showToast('导出失败: ' + prettyError(e), 'error');
	}
}

export function downloadFile(blob, ext) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${APP_NAME}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
	a.click();
	URL.revokeObjectURL(url);
}

export function clearDatabase() {
	SimpleModal({
		message: '删除所有数据（对话、预设、历史记录）？',
		accent: 'danger',
		onConfirm() {
			deleteDatabase().then(() => {
				location.reload();
			})
		}
	});
}
