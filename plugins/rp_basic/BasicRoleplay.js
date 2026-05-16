import {config, MessageRoles} from "/src/states.js";
import {downloadFile, importConversationData, registerDataImportHandler} from "/src/data-exchange.js";
import {
	$computed,
	$foreach,
	$state,
	$store,
	$unwatch,
	$update,
	$watch,
	appendChildren,
	debugSymbol,
	unconscious
} from "unconscious";
import {SETTINGS} from "/src/settings.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";

import {cloneNamed, getTextContent} from "/src/utils/utils.js";
import {readPNG} from "/common/upng.js";
import {isIDB, kvListDel, kvListGet, kvListGetKeys, kvListSet} from "/src/database.js";
import {onConversationChanged, registerTools} from "/src/skills.js";
import {showToast} from "/src/components/Toast.js";
import {Dropdown} from "/src/components/Dropdown.jsx";
import {createTab} from "/src/components/SettingDialog.jsx";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {_CharacterEditor, _LorebookEditor, _PresetEditor, createPanel, markDirty} from "./PresetPanel.jsx";
import {convertSTCharacter, convertSTLorebook, convertSTPreset, normalizeCRLF, utf2str} from "./convert.js";
import {applyMacro, applyPreset, applyRenderReplace, createDefaultCtx, DEFAULT_USER_NAME, makeStory} from "./prompt.js";
import {LorebookList, PresetList} from "./TagList.jsx";
import schema from "./schema.json";
import {compileSchema, validateAndShowError} from "unconscious/common/json-schema-utils.js";
import {onLoad} from "/src/plugin.js";
import {openJsonEditor} from "/src/json_editor/editorProxy.js";

compileSchema(schema);

const definition = {
	'st|preset': [
		"预设",
		["prompts", "regexps"],
	],
	'st|char': [
		"角色",
		["creator", "creatorNotes", "tags", "systemPrompt", "description", "personality", "scenario", "dialogueExamples", "greetings", "lorebook", "autoMessages"]
	],
	'st|lorebook': [
		"世界书",
		["pages"]
	]
};


// MyCharacterInstance用到的非序列化属性
const _instances = debugSymbol("MCI_READY");

//region misc 初始化 & 状态管理
function showOverwriteConfirm(item, typeStr, callback) {
	if (item._dirty) {
		SimpleModal({
			title: "当前" + typeStr + "已修改",
			message: "点击确定丢弃修改的内容，或点击返回以保存。",
			onConfirm: callback
		})
	} else {
		callback();
	}
}

const storeOptions = {
	persist: true,
	// TODO 实现 N-layer deep
	deep: false
};

/**
 *
 * @param {string} typeId - ID st|preset
 * @param {Object} template - 新项目模板
 * @param {Function} editorConstructor
 * @return {[
 *     element: import("unconscious").Renderable,
 *     open: function(): void,
 *     items: import("unconscious").Reactive<(Object & AiChat.IDBKVList)[]>,
 *     item: import("unconscious").Reactive<Object & AiChat.IDBKVList>,
 *     onImported: function(id: number, name: string): void,
 * ]}
 */
function _SchemaEditorImpl(typeId, template, editorConstructor) {
	/** @type {import("unconscious").Reactive<AiChat.IDBKVList[]>} */
	const items = $state([]);
	/** @type {import("unconscious").Reactive<IDBKVList>} */
	const selectedItem = $store(typeId, undefined, storeOptions);

	let {open: _openPanel, close: _closePanel} = createPanel(editorConstructor);
	const openEditor = () => _openPanel(selectedItem);

	const arr = definition[typeId];
	const typeStr = arr[0];

	const dropdown = <Dropdown
		items={items}
		selection={$computed(() => (selectedItem._dirty || "") + (selectedItem.name || "空白"))}
		onChanged={(type, index) => {
			if (type === 'd') {
				const [key] = items.splice(index, 1);
				kvListDel(typeId, key.name);
			} else {
				showOverwriteConfirm(selectedItem, typeStr, () => kvListGet(typeId, items[index].name).then(value => {
					selectedItem.value = value;
					delete selectedItem._dirty;
					$update(selectedItem);
					dropdown.setSelection(index);
				}));
			}
		}}/>;
	const onInserted = dropdown.onInserted;

	arr.push(onInserted);

	const element = <>
		<div className={"choice-scroll"}>
			<button className={"btn ghost"} onClick={() => {
				showOverwriteConfirm(selectedItem, typeStr, () => {
					selectedItem.value = structuredClone(template);
				});
			}}>新建
			</button>
			<button className={"btn ghost"} onClick={openEditor} disabled={() => !selectedItem.value}>编辑</button>
			<button className={"btn ghost"} disabled={() => !selectedItem._dirty} onClick={() => {
				SimpleModal({
					type: "input",
					title: "输入"+typeStr+"名称以另存问, 留空覆写",
					onConfirm(name) {
						delete selectedItem._dirty;
						const oldName = selectedItem.name;
						if (name && name !== oldName) delete selectedItem.id; // 在数据库里创建新项目
						else name = oldName;

						kvListSet(selectedItem.value, typeId, name).then(() => {
							onInserted(typeId, name);
						});
					}
				})
			}}>保存
			</button>
			<button className={"btn ghost"} disabled={() => !selectedItem.value}
					onClick={() => {
						const value = structuredClone(unconscious(selectedItem));
						value.type = typeId;
						downloadFile(new Blob([JSON.stringify(value)]), "json");
					}}>
				导出
			</button>
			<button className={"btn ghost"} disabled={() => !selectedItem.value} onClick={() => {
				const key = typeId+":"+selectedItem.name;

				let skipNext;
				const [updateValue, onClose] = openJsonEditor(key, () => {
					const { name, type, time, _dirty, ...rest } = unconscious(selectedItem);
					return JSON.stringify(rest, null, 2);
				}, (v) => {
					const obj = JSON.parse(v);
					obj.name = selectedItem.name;
					obj.type = selectedItem.type;
					markDirty(obj);
					selectedItem.value = obj;
					skipNext = true;
				});
				const syncToEditor = () => {
					if (skipNext) skipNext = false;
					else updateValue();
				};

				$watch(selectedItem, syncToEditor, false);
				onClose(() => $unwatch(selectedItem, syncToEditor));
			}}>编辑原始数据 <i className={"ri-external-link-line"}/>
			</button>
		</div>
		<br/>
		{dropdown}
	</>;

	return [
		element,
		openEditor,
		items,
		selectedItem,
	];
}

//endregion

const [presetBar, openPresetPanel, presetList, currentPreset] = _SchemaEditorImpl("st|preset", {name: "空白"}, _PresetEditor);
const [charBar, openCharPanel, characterList, currentCharacter] = _SchemaEditorImpl("st|char", {name: "新角色"}, _CharacterEditor);
const [lorebookBar, openLorebookPanel, lorebookList, currentLorebook] = _SchemaEditorImpl("st|lorebook", {name: "新的世界"}, _LorebookEditor);

charBar[0].append(<button className={"btn ghost"} title={"请先保存再创建故事"} disabled={() => !currentCharacter.name} onClick={() => {
	createConversation(unconscious(currentCharacter));
}}>创建故事</button>);

createTab("character", "角色", "ri-user-heart-line");
SETTINGS.filter((item) => item._id === "import").forEach((item) => {
	if (!Array.isArray(item._tab)) {
		item._tab = [item._tab || "general", "character"];
	} else {
		item._tab.push("character");
	}
});
SETTINGS.push(
	{
		id: "st_username",
		name: "你的名字",
		title: "可在角色设定中单独设置",
		type: "input",
		placeholder: DEFAULT_USER_NAME,
		_tab: "character"
	},
	{
		id: "st_userdesc",
		name: "自我介绍",
		type: "textbox",
		placeholder: "{{user}}是一个35岁的男性提夫林程序员，正在担心被深水城的雾雨魔法店裁员（我在写什么？）",
		_tab: "character"
	},
	{
		id: "st_useTools",
		name: "世界书模式",
		title: "基于工具调用的世界书和变量系统\n刷新对话生效",
		type: "radio",
		required: true,
		_tab: "character",
		choices: {
			"正则匹配": false,
			"工具调用(实验性)": true,
			"1-Shot(笨模型)": "1-shot"
		}
	},
	{
		name: "预设/补全配置",
		_tab: "character",
		type: "element",
		element: presetBar
	},
	{
		name: "角色",
		_tab: "character",
		type: "element",
		element: charBar
	},
	{
		name: "世界书",
		_tab: "character",
		type: "element",
		element: lorebookBar
	},
	{
		id: "st_postProcess",
		name: "提示词后处理",
		type: "radio",
		_tab: "character",
		choices: {
			"单系统消息": 1,
			"交替对话": 2
		}
	},
	{
		id: "st_extraElement",
		name: "解析可能不安全的HTML标签",
		type: "multiple",
		_tab: "character",
		choices: {
			"样式(style)": "style",
			"代码(script)": "script"
		}
	},
);

onLoad(() => {
	kvListGetKeys("st|preset").then(arr => presetList.value = arr);
	kvListGetKeys("st|char").then(arr => characterList.value = arr);
	kvListGetKeys("st|lorebook").then(arr => lorebookList.value = arr);
})

//region 工具调用世界书 实验性
const lorebookToolKey = [];
let lorebookToolContent = {};
const lorebookToolExample = [
	{
		"role": "user",
		"content": "Tool Call Example:\n你觉得现在的\"格利泽581-d型共振\"对我的精神状态有影响吗？",
	},
	{
		"role": "assistant",
		"content": "",
		"think": {
			"content": "用户问了一个关于\"格利泽581-d型共振\"的问题。\n\n我应当优先检索世界书（Lorebook）中相关的内容。\n\n让我查看一下相关的世界书ID：\n- LORE_3054: 格利泽,共振\n\n这个ID包含了关于格利泽581-d型共振的内容。\n\n我需要调用fetch_lorebook工具来获取更详细的世界书信息，以便更准确地回答这个问题。",
			"format": "rc"
		},
		"tool_calls": [
			{
				"id": "tool_call_1",
				"type": "function",
				"function": {
					"name": "fetch_lorebook",
					"arguments": "{\"id\":\"LORE_3054\"}"
				}
			}
		],
		"tool_responses": [
			{
				"success": true,
				"content": "一种高频亚空间波动。长期接触会导致个体产生‘逻辑坍塌’，但可被‘MXHX稳定器’抵消。"
			}
		]
	},
	{
		"role": "assistant",
		"content": "Tool Call Example:\n关于这种共振……你不必太担心。虽然这种频率会导致通常意义上的‘逻辑坍塌’，但你身上佩戴的MXHX稳定器足以过滤掉那些干扰信号。只要你不试图去‘听’那种深蓝色的噪音，你的精神状态会非常安全。",
		"think": {
			"content": "好的，我获取到了\"格利泽581-d型共振\"的详细信息。现在可以结合这些信息来回答{{char}}对这个问题可能的回应。\n\n根据信息和上下文：\n1. 该共振会导致\"逻辑坍塌\"，但对有稳定器的人无害。\n2. {{user}}佩戴有稳定器\n\n现在可以结合这些信息来回答。",
			"format": "rc"
		}
	}
];

/** @type {AiChat.FunctionTool} */
const lorebookTool = {
	name: "fetch_lorebook",
	description: "读取世界书。" +
		"当讲述者在角色扮演过程中遇到世界书有介绍的项目时，调用该工具获取详细内容\n你可以多次调用该工具",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				enum: lorebookToolKey
			}
		},
		required: ["id"]
	},

	script({id}, response) {
		response.id = id;
		return lorebookToolContent[id].content;
	},
	renderer({id}) {
		const lorebookValue = lorebookToolContent[id];
		return lorebookValue && <blockquote>
			读取世界书条目：{lorebookValue.triggers.join("\n")}
		</blockquote>
	}
};

registerTools("st", "", [lorebookTool], {hidden: true});
//endregion

// 对话从数据库加载完成回调
onConversationChanged((conv, messages) => {
	//reset
	lorebookToolKey.length = 0;
	lorebookToolContent = {};

	/** @type {AiChat.DnD.MyCharConversation} */
	const charInstance = messages[0];
	const isCharacterCard = charInstance?.role === "st|char";
	if (!isCharacterCard) return;

	const data = charInstance.content;
	let {
		name,
		presetName,
		lorebookNames = [],
	} = data;
	data.lorebookNames = lorebookNames;

	const lorebookSize = lorebookNames.length;
	const readyObj = $state({
		activatedLorebookItems: $state([]),
		lorebooks: $state(Array(lorebookSize))
	});

	const promises = [kvListGet("st|char", name).then(item => {
		readyObj.character = item;
	})];
	if (presetName) promises.push(kvListGet("st|preset", presetName).then(item => {
		readyObj.preset = item;
	}));

	if (lorebookSize) {
		for (let i = 0; i < lorebookSize; i++) {
			const j = i;
			const lorebookName = lorebookNames[i];
			if (lorebookName !== "") {
				promises.push(kvListGet("st|lorebook", lorebookName).then(item => {
					readyObj.lorebooks[j] = item;
				}));
			}
		}
	}

	Promise.all(promises).finally(() => {
		charInstance[_instances] = readyObj;
		if (readyObj.character?.greetings?.length) {
			messages.splice(1, 0, {
				id: -1, // 不保存到数据库
				role: "st|greeting",
				content: charInstance
			});
		}
		$update(updateMessageUI);
		queueMicrotask(() => {
			// 不再调用getChunks (当然虚拟列表不会让它真的只渲染一次的……)
			readyObj.stable = true;
		});
	})
});

//region 数据导入
/**
 *
 * @param {string} typeId
 * @param {Object} json
 * @param {File} imageBlob
 * @return {Promise<true>}
 */
function importObject(typeId, json, imageBlob) {
	const [typeStr, names, callback] = definition[typeId];
	const cloned = cloneNamed(json, ["name", "time", ...names]);
	if (imageBlob && !isIDB) cloned.image = imageBlob;

	return kvListSet(cloned, typeId).then(() => {
		callback(typeId, json.name);
		showToast(typeStr+" "+json.name+" 导入成功", 'ok');
		return true;
	});
}

const checkJSON = (json, batch, fileName, imageBlob) => {
	// 把 \r 去掉
	json = normalizeCRLF(json);

	if (json.spec === "chara_card_v3" || json.spec === "chara_card_v2") {
		json = convertSTCharacter(json);
		return importObject("st|char", json, imageBlob);
	} else if (json.prompts && json.prompt_order) {
		json = convertSTPreset(json, fileName, (err) => showToast(err, "error", 0));
		return importObject("st|preset", json, imageBlob);
	} else if (json.entries) {
		json = convertSTLorebook(json, fileName);
		return importObject("st|lorebook", json, imageBlob);
	}

	if (definition[json.type]) {
		const error = validateAndShowError(json, schema.$defs[json.type]);
		if (error) {
			showToast("格式校验失败\n"+error, 'error', 10000);
			return;
		}
		return importObject(json.type, json, imageBlob);
	}
};

registerDataImportHandler("application/json", checkJSON);

registerDataImportHandler("image/png", async (file, batch) => {
	const ab = await file.arrayBuffer();
	const {chara} = readPNG(ab);
	if (!chara) return;

	const data = JSON.parse(utf2str(atob(chara)));
	const result = checkJSON(data, batch, file.name, file);
	if (result) return await result;
});

//endregion
//region 从角色卡新建对话和相关UI组件
/**
 * 从角色新建对话
 * @param {AiChat.DnD.MyCharacter} char
 * @return {Promise<boolean>}
 */
async function createConversation(char) {
	await importConversationData({
		title: "[Char] "+char.name,
		time: char.time || Date.now(),
		messages: [
			{
				role: "st|char",
				content: {
					id: char.id,
					name: char.name,
					// ""为嵌入世界书（若存在）保留
					lorebookNames: [""],
					activatedLorebookItems: new Set,
					greeting: 0
				}
			}
		]
	});

	showToast("已创建 "+char.name+" 的新对话", "ok");
	return true;
}

function insertAfter(text, msg) {
	const template = "\n\n" + applyMacro(text);
	if (Array.isArray(msg.content)) {
		msg.content.push({
			type: "text",
			text: template
		})
	} else {
		msg.content += template;
	}
}

/**
 *
 * @param {AiChat.DnD.MyCharConversation} self
 * @return {JSX.Element}
 */
const StoryConfigPanel = self => {
	const selectedLorebooks = $state(self.content.lorebookNames);
	const selectedPreset = $state(self.content.presetName);

	const update = () => {
		self[_instances].stable = false;
		$update(updateMessageUI);
		queueMicrotask(() => self[_instances].stable = true);
	};

	$watch(selectedPreset, () => {
		const name = selectedPreset.value;
		kvListGet("st|preset", name).then(item => {
			self.content.presetName = name;
			self[_instances].preset = item;
			update();
		});
	}, false);

	$watch(selectedLorebooks, () => {
		const nameArr = selectedLorebooks.value;
		const valueArr = Array(nameArr.length);
		self[_instances].lorebooks.value = valueArr;

		const promises = [];

		for (let i = 0; i < nameArr.length; i++){
			const j = i;
			promises.push(kvListGet("st|lorebook", nameArr[i]).then(item => {
				valueArr[j] = item;
			}));
		}

		Promise.all(promises).then(update);
	}, false);

	return <div style={"display:flex;justify-content:space-around"}>
			<LorebookList items={lorebookList} selection={selectedLorebooks} />
			<PresetList items={presetList} selection={selectedPreset} />
	</div>;
};

MessageRoles["st|char"] = {
	name: "角色卡",
	reactive(self) {
		return !self.key[_instances]?.stable;
	},
	/**
	 *
	 * @param {AiChat.DnD.MyCharConversation} self
	 * @param output
	 * @param callbacks
	 */
	compose(self, output, callbacks) {
		callbacks.push((input, output, body, prefill, conv) => {
			let {
				/** @type {AiChat.DnD.MyCharacter} */
				character: char,
				/** @type {AiChat.DnD.MyLorebook[]} */
				lorebooks,
				/** @type {AiChat.DnD.MyPreset} */
				preset = unconscious(currentPreset)
			} = self[_instances];

			//region 插入消息
			if (char.autoMessages?.length) {
				for (let {enabled, depth, content} of char.autoMessages) {
					if (!enabled) continue;

					const msg = output[output.length - 1 - depth];
					if (msg && (depth !== 0 || msg.role === "user")) insertAfter(content, msg);
				}
			}
			//endregion
			let lbBefore = '', lbAfter = '', lbLast = '';
			//region 处理世界书

			/** @type {AiChat.DnD.MyLorebookPage[]} */
			const pages = [];
			for (let lorebook of lorebooks) {
				if (lorebook) pages.push(...lorebook.pages.filter(item => item.enabled && item.content));
			}

			if (config.st_useTools) {
				const {allowedTools} = conv;
				if (!allowedTools) conv.allowedTools = new Set([lorebookTool.name]);
				else allowedTools.add(lorebookTool.name);

				lorebookToolKey.length = 0;
				lorebookToolContent = {};

				const keywords = [];
				for (let page of pages) {
					if (page.constant) lbBefore += "\n\n"+page.content;
					else {
						lorebookToolKey.push(page.id);
						lorebookToolContent[page.id] = page.content;
						keywords.push(" - "+page.id+": "+page.triggers.join(","));
					}
				}
				lbBefore += "\n\n<lorebook>\n世界书ID与关键词的映射：\n"+keywords.join("\n")+"\n</lorebook>";
			} else {
				const activeBooks = self.content.activatedLorebookItems;

				for (let book of pages) {
					let found = activeBooks.has(book.id) || book.constant;

					// TODO 最好做一个基于滑动窗口的缓存
					if (!book.constant) {
						found = false;

						const min = book.window === 50 ? 0 : Math.max(0, output.length - book.window);
						for (let i = output.length-1; i >= min; i--) {
							let text = getTextContent(output[i])?.toLowerCase();

							found = new RegExp(book.triggers.join("|"), 'miu').exec(text);
							if (found) break;
						}
					}

					if (found) {
						activeBooks.add(book.id);
						const content = "\n\n"+book.content;
						if (book.position === "worldInfoBefore") lbBefore += content;
						else if (book.position === "worldInfoAfter") lbAfter += content;
						else {
							let depth = book.depth;
							for (let i = output.length-1; i >= 0; i--) {
								const o = output[i];
								if ((!book.role || o.role === book.role) && !--depth) {
									o.content += lbLast;
									break;
								}
							}
						}
					} else {
						activeBooks.delete(book.id);
					}
				}

				// TODO 用名字而不是ID方便调试
				self[_instances].activatedLorebookItems.value = Array.from(activeBooks.keys());
			}
			//endregion

			const macro = createDefaultCtx(char);

			let prefix = '';
			const hasSystemMessage = output[0].role === "system";
			if (hasSystemMessage) prefix = applyMacro(output[0].content, macro)+"\n\n";

			if (preset.prompts?.length) {
				const content = applyPreset(preset, {
					...macro,
					personaDescription: char.userdesc || config.st_userdesc,
					worldInfoBefore: lbBefore,
					worldInfoAfter: lbAfter
				}, output, prefill);

				output.length = 0;
				output.push(...content);
			} else {
				const content = prefix + makeStory(char, lbBefore, lbAfter);
				if (hasSystemMessage) {
					output[0].content = content;
				} else {
					output.unshift({
						role: "system",
						content
					})
				}
			}

			if (config.st_useTools === "1-shot")
				output.splice(1, 0, ...lorebookToolExample);
		});
	},
	/**
	 *
	 * @param {AiChat.DnD.MyCharConversation} self
	 * @param chunks
	 * @param index
	 */
	getChunks(self, chunks, index) {
		if (!self[_instances]) {
			chunks.push({ type: "loading", text: "加载中" });
			return;
		}

		const {
			/** @type {AiChat.DnD.MyCharacter} */
			character: char,
			/** @type {AiChat.DnD.MyLorebook[]} */
			lorebooks,
			/** @type {AiChat.DnD.MyPreset} */
			preset,
			/** @type {import("unconscious").Reactive<string[]>} */
			activatedLorebookItems
		} = self[_instances];

		if (!char) {
			chunks.push({
				type: "error",
				error: "致命错误\n引用的角色 "+self.content.name+" 不存在"
			});
			return;
		}

		const number = self.content.lorebookNames.indexOf("");
		if (number >= 0 && char.lorebook?.length) {
			lorebooks[number] = {
				name: "角色卡内置",
				pages: char.lorebook
			}
		}

		let head =  "## "+char.name;
		if (char.creator) head += "\n作者：" + char.creator;

		chunks.push({
			key: head,
			// text 就是 markdown
			type: "text",
			text: head
		});

		const creatorNotes = char.creatorNotes;
		if (creatorNotes) {
			chunks.push({
				type: "think",
				think: {
					// 覆盖思考块的标题
					title: "作者的话 ("+creatorNotes.length+"字符)",
					// 这也是 markdown
					content: creatorNotes
				}
			});
		}

		const defaultSystemPrompt = makeStory(char, "\n\n<worldInfoBefore>", "\n\n<worldInfoAfter>");
		chunks.push({
			type: "think",
			think: {
				title: "系统消息 (未应用预设) ("+defaultSystemPrompt.length+"字符)",
				content: defaultSystemPrompt
			}
		});

		// 这里需要存放名字来提供用户友好的错误提示吗？
		// 或者我们可以直接用name做key？
		// 这个要 kvListGet(type, name); 走不了现在的 id 缓存
		// 反正覆盖不会导致ID变更，只有删除才会，用ID应该问题不大
		// 另外这个要搞成响应式的
		for (let i = 0; i < lorebooks.length; i++){
			let lorebook = lorebooks[i];
			if (lorebook?.pages == null) {
				if (self.content.lorebookNames[i] !== "") {
					chunks.push({
						type: "error",
						error: "错误\n引用的世界书 "+self.content.lorebookNames?.[i]+" 不存在"
					});
				}
			} else {
				const {name, pages} = lorebook;
				chunks.push({
					type: "html",
					html: <details className={"think"}>
						<summary>
							<span className="chevron ri-play-large-fill"></span>
							世界书 ({name}) ({pages.length}项)
						</summary>
						<div className="think-content">
							{pages.map(item => _LorebookPage(item))}
						</div>
					</details>
				});
			}
		}

		if (!preset && self.content.presetName) {
			chunks.push({
				type: "error",
				error: "错误\n引用的预设 "+self.content.presetName+" 不存在"
			});
		}

		chunks.push({
			// 必须写key=self才会调用下面的keyFunc
			key: self,
			id: "html1",

			type: "html",
			html: () => StoryConfigPanel(self)
		});

		chunks.push({
			key: self,
			id: "html2",

			type: "html",
			// 顶层元素不能为动态的，现在貌似会出问题
			html: () => <div>
				{() =>
					activatedLorebookItems.length ? (<details className={"think"}>
						<summary>
							<span className="chevron ri-play-large-fill"></span>
							目前激活 {() => activatedLorebookItems.length} 个世界书条目
						</summary>
						<ul>{$foreach(activatedLorebookItems, item => <li>{item}</li>)}</ul>
					</details>) : undefined
				}
			</div>
		});
	},
	keyFunc(chunk) {
		if (chunk.type === "html") {
			return chunk.id;
		}
	}
};

MessageRoles["st|greeting"] = {
	name: "开场白",
	reactive: true,
	/**
	 * @param {AiChat.DnD.MyCharConversation} card
	 * @param output
	 */
	compose({content: card}, output) {
		const char = card[_instances].character;
		output.push({
			role: "assistant",
			content: applyMacro(char.greetings[card.content.greeting], createDefaultCtx(char))
		});
	},
	/**
	 * @param {AiChat.DnD.MyGreeting} self
	 * @param chunks
	 */
	getChunks(self, chunks) {
		const card = self.content;
		const char = card[_instances].character;
		const greetings = char.greetings;

		let index = card.content.greeting;
		if (!greetings[index]) card.content.greeting = index = 0;

		chunks.push({
			key: self,
			type: "text",
			text: applyMacro(greetings[index], createDefaultCtx(char))
		});
		if (greetings.length > 1) {
			chunks.push({
				key: self,
				type: "branch",
				current: index,
				total: greetings.length,
				callback(choice) {
					card.content.greeting = choice;
					$update(updateMessageUI);
				}
			})
		}
	},
	keyFunc(chunk) {
		return [chunk, chunk.key.content.greeting];
	}
};

MessageRoles["assistant"] = {
	getChunks(message, chunks, index, isEditing, messages, isPostHook) {
		if (!isPostHook) return true;

		const isRP = messages[0]?.[_instances];
		if (!isRP) return;

		const preset = isRP.preset || unconscious(currentPreset);
		if (!preset) return;

		for (let i = chunks.length - 1; i >= 0; i--) {
			const chunk = chunks[i];
			if (chunk.type === "text") {
				chunk.text = applyRenderReplace(preset, chunk.text, index);
				break;
			}
		}
	}
};

/**
 * @param {AiChat.DnD.MyLorebookPage} item
 * @return {JSX.Element}
 */
function _LorebookPage(item) {
	let {name, enabled, comment, content, regex, constant, recursion, triggers, window, position, id, depth} = item;
	const attributes = [];
	if (!enabled) attributes.push("禁用");
	if (constant) attributes.push("常驻");
	if (recursion) attributes.push("递归");
	if (regex) attributes.push("正则");
	if (window === 50) attributes.push("永久激活");
	if (position === "depth") position += "@"+depth;

	const el = <details onClick.once={() => {
		appendChildren(el, <>
			<pre className="code-block">
				<div className="code-header sticky">
					<span>注释和元数据</span>
					<span className="buttons">
						<button className="ri-file-copy-line ghost" data-action="copy" title="复制代码"></button>
					</span>
				</div>
				<code className={"hljs"}>
					ID：{id}<br/>
					属性：{attributes.join(" ")}<br/>
					位置：{position}<br/>
					触发词：<ul style={"margin:0"}>{triggers.map(s => <li>{s}</li>)}</ul>
					{comment}
				</code>
			</pre>
			<pre className="code-block">
				<div className="code-header sticky">
					<span>{name || "内容"}</span>
					<span className="buttons">
						<button className="ri-download-2-line ghost" data-action="download" title="下载代码"></button>
						<button className="ri-file-copy-line ghost" data-action="copy" title="复制代码"></button>
					</span>
				</div>
				<code className={"hljs"}>{content}</code>
			</pre>
		</>)
		el.append();
	}}>
		<summary>{name || comment || `${triggers.map(JSON.stringify).join(" | ")}` || "无标题"}</summary>
	</details>;
	return el;
}

//endregion