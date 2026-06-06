import {config, conversations, messages, selectedConversation, Shared} from "./states.js";
import {showToast} from "./components/Toast.js";
import {deleteDatabase, getMessages, kvListGetValues, kvListSet, updateConversation} from "./database.js";
import {prettyError} from "./utils/utils.js";
import SimpleModal from "./components/SimpleModal.jsx";
import {ZipReader, ZipWriter} from "unconscious/common/zip-io.js";
import {$computed, $state, $update, unconscious} from "unconscious";
import {reloadPresetList} from "./components/PresetDropdown.jsx";
import {decodeObjects, serializeJSON} from "./utils/marshal.js";

const sleep = () => new Promise(resolve => setTimeout(resolve));

/**
 *
 * @param {Partial<AiChat.Conversation> & {messages: AiChat.Message[]}} convData
 * @param {boolean=false} batch
 * @return {Promise<AiChat.Conversation>}
 */
export const importConversationData = async ({messages: messages_, id, ...conv}, batch) => {
	if (!Number.isFinite(conv.time)) conv.time = Date.now();
	if (typeof conv.title !== "string") conv.title = "";

	if (messages_) {
		messages_.sort((a, b) => {
			if (a.time && b.time) return a.time - b.time;
			return 0;
		}).forEach(message => {
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

	const data = await zipFile.getText(APP_NAME);
	if (data !== '1') {
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
		reloadPresetList();
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

				new_convs.push(await importConversationData(await decodeObjects(JSON.parse(text), zipFile), true));
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
		Shared.SettingUI.sync();
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
};

export const duplicateConversation = async () => {
	const conv = unconscious(selectedConversation);
	if (!conv?.ready) {
		showToast('无对话选中', 'error');
		return;
	}

	await importConversationData({
		...conv,
		messages: unconscious(messages).filter(item => item.id >= 0)
	});

	showToast('已将当前对话另存为', 'ok');
};

const cleanMessages = messages => {
	for (const message of messages) delete message.id;
	return messages;
};

export const exportConversation = async (isConfig, _conv) => {
	const includePlugins = import.meta.env.DEV;

	const mapping = new Map;
	const replacer = (_, value) => {
		return mapping.get(value) ?? value;
	};

	const zw = ZipWriter();
	await zw.add(APP_NAME, "1");

	if (isConfig) {
		const compression = {compress: true};

		await zw.add("config.json", JSON.stringify(config), compression);

		const kvList = await kvListGetValues(includePlugins ? "*" : "preset");
		const jsonData = await serializeJSON(kvList, 0, zw);

		await zw.add("kvList.json", jsonData, compression);
	} else {
		const conv = _conv || unconscious(selectedConversation);
		if (conv) {
			const { id: _a, ready: _b, ...data } = conv;

			let messagePromise = unconscious(messages);
			try {
				messagePromise = await getMessages(conv);
			} catch {}
			data.messages = cleanMessages(messagePromise);

			const jsonData = await serializeJSON(data.messages, 0, zw);
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
			const conversations1 = unconscious(conversations);
			let close = showToast($computed(() => '已导出 '+unconscious(successed)+'/'+conversations1.length+' 条数据…'), '', 0);

			const callbacks = [];
			for (let i = 0; i < conversations1.length; i++) {
				const conv = conversations1[i];
				const reversedIndex = conversations1.length - 1 - i;

				const { id: _a, ready: _b, ...data } = conv;

				if (((i+1) & 15) === 0) await sleep();

				callbacks.push(getMessages(conv).then(messages => {
					data.messages = cleanMessages(messages);
					return serializeJSON(data, 0, zw).then(text => {
						successed.value ++;
						return zw.add(`conversations/${reversedIndex}.json`, text, {
							timestamp: data.time,
							compress: true
						});
					});
				}));
			}

			await Promise.all(callbacks);
			close();
		}
	}

	try {
		downloadFile(zw.finish(), "zip");
	} catch (e) {
		console.error(e);
		showToast('导出失败: ' + prettyError(e), 'error');
	}
};

export const downloadFile = (blob, ext) => {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = blob.name || `${APP_NAME}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
	a.click();
	URL.revokeObjectURL(url);
};

export const clearDatabase = () => {
	SimpleModal({
		message: '删除所有数据（对话、预设、历史记录）？',
		accent: 'danger',
		onConfirm() {
			deleteDatabase().then(() => {
				location.reload();
			})
		}
	});
};
