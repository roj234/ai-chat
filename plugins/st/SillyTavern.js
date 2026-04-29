import {config, MessageRoles, selectedConversation} from "/src/states.js";
import {downloadFile, importConversationData, registerDataImportHandler} from "/src/data-exchange.js";
import {
	$computed,
	$foreach,
	$state,
	$store,
	$update,
	$watch,
	appendChildren,
	debugSymbol,
	unconscious
} from "unconscious";
import {SETTINGS} from "/src/settings.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";

import {cloneNamed, getTextContent} from "/src/utils/utils.js";
import {readPNG} from "/vendor/upng.js";
import {kvListDel, kvListGet, kvListGetByName, kvListGetKeys, kvListSet} from "/src/database.js";
import {onConversationChanged, registerTools} from "/src/skills.js";
import {showToast} from "/src/components/Toast.js";
import {Dropdown} from "/src/components/Dropdown.jsx";
import {COMMANDS} from "/src/commands.js";
import {createTab} from "/src/components/SettingDialog.jsx";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {_CharacterEditor, _LorebookEditor, _PresetEditor, createPanel} from "./STPresetPanel.jsx";
import {convertSTCharacter, convertSTLorebook, convertSTPreset, normalizeCRLF, utf2str} from "./convert.js";
import {applyMacro, applyPreset, createDefaultCtx, DEFAULT_USER_NAME, makeStory} from "./prompt.js";
import {LorebookList, PresetList} from "./STTagList.jsx";

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
const _FetchFromDB = debugSymbol("MCI_READY");

//region misc 初始化 & 状态管理
/** @type {Map<number, WeakRef<AiChat.IDBKVList & Object>>} */
const cache = new Map;
/**
 * @param {number} id
 * @return {Promise<object>}
 * @private
 */
async function _kvListGetCached(id) {
	// 同时检查Null
	if (id <= 0) return Promise.resolve();

	let val = cache.get(id)?.deref();
	if (!val) {
		val = await kvListGet(id);
		if (val) cache.set(id, new WeakRef(val));
	}
	return val;
}

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

	kvListGetKeys(typeId).then(arr => items.value = arr);

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
				kvListDel(key.id);
			} else {
				showOverwriteConfirm(selectedItem, typeStr, () => _kvListGetCached(items[index].id).then(value => {
					delete value.type;

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
			<button className={"btn ghost"} onClick={openEditor}>编辑</button>
			<button className={"btn ghost"} onClick={() => {
				showOverwriteConfirm(selectedItem, typeStr, () => {
					selectedItem.value = structuredClone(template);
				});
			}}>新建
			</button>
			<button className={"btn ghost"} disabled={() => !selectedItem._dirty} onClick={() => {
				SimpleModal({
					type: "input",
					title: "输入"+typeStr+"名称以另存问, 留空覆写",
					onConfirm(name) {
						delete selectedItem._dirty;
						const oldName = selectedItem.name;
						if (name && name !== oldName) delete selectedItem.id; // 在数据库里创建新项目
						else name = oldName;

						kvListSet(selectedItem.value, typeId, name).then(id => {
							onInserted(id, name);
							selectedItem.id = id;
						});
					}
				})
			}}>保存
			</button>
			<button className={"btn ghost"} disabled={() => !selectedItem.value} onClick={() => {
				const value = structuredClone(unconscious(selectedItem));
				value.type = typeId;
				delete value.id;
				downloadFile(new Blob([JSON.stringify(value)]), "json");
			}}>导出
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
		onInserted,
	];
}

//endregion

const [presetBar, openPresetPanel, presetList, currentPreset] = _SchemaEditorImpl("st|preset", {name: "空白"}, _PresetEditor);
const [charBar, openCharPanel, characterList, currentCharacter] = _SchemaEditorImpl("st|char", {name: "新角色"}, _CharacterEditor);
const [lorebookBar, openLorebookPanel, lorebookList, currentLorebook] = _SchemaEditorImpl("st|lorebook", {name: "新的世界"}, _LorebookEditor);

charBar[0].append(<button className={"btn ghost"} title={"请先保存再创建故事"} disabled={() => !currentCharacter.id} onClick={() => {
	createConversation(unconscious(currentCharacter));
}}>创建故事</button>);

COMMANDS["stpreset"] = openPresetPanel;
COMMANDS["stchar"] = openCharPanel;
COMMANDS["stlorebook"] = openLorebookPanel;

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
		name: "[ST] 你的名字",
		type: "input",
		placeholder: DEFAULT_USER_NAME,
		_tab: "character"
	},
	{
		id: "st_userdesc",
		name: "[ST] 自我介绍",
		type: "textbox",
		placeholder: "{{user}}是一个35岁的男性提夫林程序员，正在担心被深水城的雾雨魔法店裁员（我在写什么？）",
		_tab: "character"
	},
	{
		id: "st_useTools",
		name: "[ST] 世界书模式",
		title: "基于工具调用的世界书和变量系统\n刷新对话生效",
		type: "radio",
		_tab: ["character", "tools"],
		choices: {
			"正则匹配": false,
			"工具调用(实验性)": true,
			"1-Shot(笨模型)": "1-shot"
		}
	},
	{
		name: "[ST] 预设/模板",
		title: "用指令 /stpreset 打开",
		_tab: ["character", "prompt"],
		type: "element",
		element: presetBar
	},
	{
		name: "[ST] 角色",
		title: "用指令 /stchar 打开",
		_tab: ["character", "prompt"],
		type: "element",
		element: charBar
	},
	{
		name: "[ST] 世界书",
		title: "用指令 /stlorebook 打开",
		_tab: ["character", "prompt"],
		type: "element",
		element: lorebookBar
	},
	{
		id: "st_postProcess",
		name: "[ST] 提示词后处理",
		type: "radio",
		_tab: ["character", "prompt"],
		choices: {
			"单系统消息": 1,
			"交替对话": 2
		}
	},
);


//region 工具调用世界书 实验性
const lorebookToolKey = [];
let lorebookToolContent = {};
const lorebookToolExample = [
	{
		st_example: 1,
		id: -1,
		hidden: true,
		"role": "user",
		"content": "Tool Call Example:\n你觉得现在的\"格利泽581-d型共振\"对我的精神状态有影响吗？",
	},
	{
		id: -1,
		hidden: true,
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
		id: -1,
		hidden: true,
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

	if (config.st_useTools) {
		const value1 = selectedConversation.value;
		// TODO 避免在这里强制
		if (!value1.activatedModules) {
			value1.activatedModules = new Set(["*"]);
			value1.allowedTools = new Set([lorebookTool.name]);
		}

		for (let i = 0; i < Math.min(messages.length, 10); i++) {
			if (messages[i].role === "st|lorebook") {
				lorebookToolKey.push(...messages[i].content.map(item => item.id));
				messages[i].content.forEach((value) => {
					if (!value.enabled) return;
					lorebookToolContent[value.id] = value;
				});
			}
		}

		if (config.st_useTools === "1-shot" && messages.findIndex(item => item.st_example) < 0)
			messages.splice(1, 0, ...lorebookToolExample);
	}

	const data = charInstance.content;
	let {
		id = -1,
		name,
		preset = -1,
		presetName,
		lorebooks ,
		lorebookNames,
	} = data;
	if (!lorebooks) {
		lorebooks = data.lorebooks = [];
		lorebookNames = data.lorebookNames = [];
	}

	const lorebookSize = lorebooks.length;
	const readyObj = $state({
		activatedLorebookItems: $state([]),
		lorebooks: $state(Array(lorebookSize))
	});

	const promises = [_kvListGetCached(id).then(item => {
		readyObj.character = item;
		if (name && (!item || item.name !== name)) return kvListGetByName("st|char", name).then(item => {
			readyObj.character = item;
			data.id = item.id;
		});
	})];
	if (preset >= 0) promises.push(_kvListGetCached(preset).then(item => {
		readyObj.preset = item;
		if (presetName && (!item || item.name !== presetName)) return kvListGetByName("st|preset", presetName).then(item => {
			readyObj.preset = item;
			data.preset = item.id;
		});
	}));

	if (lorebookSize) {
		for (let i = 0; i < lorebookSize; i++) {
			const j = i;
			promises.push(_kvListGetCached(lorebooks[i]).then(item => {
				readyObj.lorebooks[j] = item;
				const lbName = lorebookNames?.[j];
				if (lbName && (!item || item.name !== presetName)) return kvListGetByName("st|lorebook", lbName).then(item => {
					readyObj.lorebooks[j] = item;
					data.lorebooks[j] = item.id;
				});
			}));
		}
	}

	Promise.all(promises).then(() => {
		charInstance[_FetchFromDB] = readyObj;
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
 * @return {Promise<true>}
 */
function importObject(typeId, json) {
	const [typeStr, names, callback] = definition[typeId];
	return kvListSet(cloneNamed(json, ["name", "time", ...names]), typeId).then(id => {
		callback(id, json.name);
		showToast(typeStr+" "+json.name+" 导入成功", 'ok');
		return true;
	});
}

const checkJSON = (json, batch, fileName) => {
	// 把 \r 去掉
	json = normalizeCRLF(json);

	if (json.spec === "chara_card_v3" || json.spec === "chara_card_v2") {
		json = convertSTCharacter(json);
		return importObject("st|char", json);
	} else if (json.prompts && json.prompt_order) {
		json = convertSTPreset(json, fileName);
		return importObject("st|preset", json);
	} else if (json.entries) {
		json = convertSTLorebook(json, fileName);
		return importObject("st|lorebook", json);
	}

	// TODO schema 校验
	if (definition[json.type]) return importObject(json.type, json);
};

registerDataImportHandler("application/json", checkJSON);

registerDataImportHandler("image/png", async (file, batch) => {
	const ab = await file.arrayBuffer();
	const {chara} = readPNG(ab);
	if (!chara) return;

	const data = JSON.parse(utf2str(atob(chara)));
	const result = checkJSON(data, batch);
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
		title: "[ST] "+char.name,
		time: char.time,
		messages: [
			{
				role: "st|char",
				content: {
					id: char.id,
					name: char.name,
					// 第一个-1是给嵌入世界书（若存在）保留的
					lorebooks: [-1],
					preset: -1,
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
 * @constructor
 */
function StoryConfigPanel(self) {
	const selectedLorebooks = $state(self.content.lorebooks);
	const selectedPreset = $state(self.content.preset);

	const update = () => {
		self[_FetchFromDB].stable = false;
		$update(updateMessageUI);
		queueMicrotask(() => self[_FetchFromDB].stable = true);
	};

	$watch(selectedPreset, () => {
		const id = selectedPreset.value;
		_kvListGetCached(id).then(item => {
			self.content.preset = id;
			self.content.presetName = item?.name;
			self[_FetchFromDB].preset = item;

			update();
		});
	}, false);

	$watch(selectedLorebooks, () => {
		const ids = selectedLorebooks.value;
		const valueArr = Array(ids.length);
		const nameArr = Array(ids.length);
		self[_FetchFromDB].lorebooks.value = valueArr;
		self.content.lorebookNames = nameArr;

		const promises = [];

		for (let i = 0; i < ids.length; i++){
			const j = i;
			promises.push(_kvListGetCached(ids[i]).then(item => {
				valueArr[j] = item;
				nameArr[j] = item?.name;
			}));
		}

		Promise.all(promises).then(update);
	}, false);

	return <div style={"display:flex;justify-content:space-around"}>
			<LorebookList items={lorebookList} selection={selectedLorebooks} />
			<PresetList items={presetList} selection={selectedPreset} />
	</div>;
}

MessageRoles["st|char"] = {
	name: "角色卡",
	reactive(self) {
		return !self.key[_FetchFromDB]?.stable;
	},
	/**
	 *
	 * @param {AiChat.DnD.MyCharConversation} self
	 * @param output
	 * @param callbacks
	 */
	compose(self, output, callbacks) {
		callbacks.push((input, output) => {
			const {
				/** @type {AiChat.DnD.MyCharacter} */
				character: char,
				/** @type {AiChat.DnD.MyLorebook[]} */
				lorebooks,
				/** @type {AiChat.DnD.MyPreset} */
				preset = unconscious(currentPreset)
			} = self[_FetchFromDB];

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
				const keywords = [];
				for (let book of pages) {
					if (book.constant) lbBefore += "\n\n"+book.content;
					else keywords.push(" "+item.id+": "+item.triggers.join(","));
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
				self[_FetchFromDB].activatedLorebookItems.value = Array.from(activeBooks.keys());
			}
			//endregion

			let prefix = '';
			const hasSystemMessage = output[0].role === "system";
			if (hasSystemMessage) prefix = applyMacro(output[0].content)+"\n\n";

			if (preset.prompts?.length) {
				const content = applyPreset(preset, {
					...createDefaultCtx(char),
					personaDescription: config.st_userdesc,
					worldInfoBefore: lbBefore,
					worldInfoAfter: lbAfter
				}, output);

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
		});
	},
	/**
	 *
	 * @param {AiChat.DnD.MyCharConversation} self
	 * @param chunks
	 * @param index
	 */
	getChunks(self, chunks, index) {
		if (!self[_FetchFromDB]) {
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
		} = self[_FetchFromDB];

		if (!char) {
			chunks.push({
				type: "error",
				error: "致命错误\n引用的角色 "+self.content.name+"(#"+self.content.id+") 不存在"
			});
			return;
		}

		const number = self.content.lorebooks.indexOf(-1);
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
		// 这个要 kvListGetByName(type, name); 走不了现在的 id 缓存
		// 反正覆盖不会导致ID变更，只有删除才会，用ID应该问题不大
		// 另外这个要搞成响应式的
		for (let i = 0; i < lorebooks.length; i++){
			let lorebook = lorebooks[i];
			if (lorebook?.pages == null) {
				if (self.content.lorebooks[i] !== -1) {
					chunks.push({
						type: "error",
						error: "错误\n引用的世界书 "+self.content.lorebookNames?.[i]+"(#"+self.content.lorebooks[i]+") 不存在"
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

		if (!preset && self.content.preset !== -1) {
			chunks.push({
				type: "error",
				error: "错误\n引用的预设 "+self.content.presetName+"(#"+self.content.preset+") 不存在"
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
	reactive(self) {
		return true;
	},
	/**
	 * @param {AiChat.DnD.MyCharConversation} card
	 * @param output
	 */
	compose({content: card}, output) {
		const char = card[_FetchFromDB].character;
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
		const char = card[_FetchFromDB].character;
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

/**
 * @param {AiChat.DnD.MyLorebookPage} item
 * @return {JSX.Element}
 * @constructor
 */
function _LorebookPage(item) {
	const {name, enabled, comment, content, regex, constant, recursion, triggers, window, position, id} = item;
	const attributes = [];
	if (!enabled) attributes.push("禁用");
	if (constant) attributes.push("常驻");
	if (recursion) attributes.push("递归");
	if (regex) attributes.push("正则");
	if (window === 50) attributes.push("永久激活");

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
					触发词：
					<ul style={"margin:0"}>{triggers.map(s => <li>{s}</li>)}</ul>
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