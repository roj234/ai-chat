

import "./STPresetPanel.css";
import {$state, $update, $watchWithCleanup, debugSymbol} from "unconscious";
import SimpleModal from "../../components/SimpleModal.jsx";
import {highlightJsonLike} from "../../utils.js";
import {VirtualList} from "unconscious/ext/VirtualList.js";
import Filter from "unconscious/ext/components/Filter.jsx";

const EXPANDED = debugSymbol("EXPANDED");
const SORT = debugSymbol("SORT");

function markDirty(preset) {
	preset._dirty = '*';
	preset.time = Date.now();
}

// P = 1000 * 1000 / (2 * Math.pow(36, 8))
// 大约1.7e-7概率在1000项世界书上发生ID重复
export function randomId() {
	return Math.random().toString(36).substring(2, 10);
}

//region 各种虚拟列表
/**
 *
 * @param {import("unconscious").Reactive<any>} dirtyHandle
 * @param {Filter.Config[]} config
 * @return {[import("unconscious").Renderable, VirtualList]}
 */
function createList(dirtyHandle, config) {
	const list = <ul onClick.delegate{"input[type=checkbox]"}={({delegateTarget}) => {
		if (!delegateTarget) return;

		const key = delegateTarget.closest("li")._key;
		key.enabled = !key.enabled;

		markDirty(dirtyHandle);
		$update(dirtyHandle);
	}} />;

	const virtualList = new VirtualList({
		element: list,
		itemHeight: 49,
		renderer(item, index) {
			item[SORT] = index + 1;
			return <li _key={item}>
				<div className={"summary"}>
					<span className="index">{index + 1}</span>
					<span className="name" title={item.name}>{item.name}</span>
					<label className="switch">
						<input
							type="checkbox"
							checked={item.enabled}
						/>
						<span className="slider"></span>
					</label>
					<button
						className="preset-panel__edit-btn"
						onClick={() => {
							item[EXPANDED] ^= true;
							virtualList.setItem(index, item);
						}}
						title="编辑/展开"
					>
						<i className={item[EXPANDED]?`ri-arrow-up-s-line`:`ri-arrow-down-s-line`}></i>
					</button>
					<button
						className="preset-panel__delete-btn"
						onClick={() => {
							SimpleModal({
								title: "确认删除",
								message: <div dangerouslySetInnerHTML={highlightJsonLike(item)}/>,
								accent: 'danger',
								onConfirm() {
									virtualList.items.splice(index, 1);
									markDirty(dirtyHandle);
									virtualList.render();
								}
							})
						}}
						title="删除"
					>
						<i className="ri-delete-bin-line"></i>
					</button>
				</div>
				{item[EXPANDED] ? (
					<Filter choices={item} config={[
						...config,
						{
							name: "序号",
							id: SORT,
							type: "number",
							min: 1,
							max: virtualList.items.length
						}
					]} onChange={(k, v, obj) => {
						markDirty(dirtyHandle);
						if (k === SORT) {
							const items = virtualList.items;
							items.splice(index, 1);
							items.splice(v-1, 0, item);
							virtualList.setItems(items);
							return true;
						}
					}} isMobile={true} />
				) : null}
			</li>;
		}
	});

	return [list, virtualList];
}

/**
 *
 * @param {import("unconscious").Reactive<any>} dirtyHandle
 * @return {[import("unconscious").Renderable,VirtualList]}
 */
function createLorebookList(dirtyHandle) {
	return createList(dirtyHandle, [
		{
			id: "name",
			name: "名称",
			title: "给这条设定起个好记的名字，同时也是 AI 调用工具时看到的条目名称",
			placeholder: "幻想乡",
			type: "input"
		},
		{
			id: "comment",
			name: "备注",
			title: "AI 调用工具时的提示，说明这条设定什么时候用、怎么用（也可以记给你自己看的注释）。",
			placeholder: "东方Project的主要舞台，位于日本某处的结界内部",
			type: "textbox"
		},
		{
			id: "content",
			name: "内容",
			placeholder: "幻想乡是人类与妖怪共存的秘境，四季分明，由博丽神社的巫女维持平衡。外界人偶尔会误入。",
			type: "textbox"
		},
		{
			name: "属性",
			type: "multiple",
			choices: {
				"正则": "regex",
				"常驻": "constant",
				"连锁": "recursion",
			},
			title: {
				"正则": "开启后，触发词将作为正则表达式处理，能匹配更复杂的模式。",
				"常驻": "不依赖触发词，对话一开始就自动加入背景，适合全局性设定（如世界观基调）。",
				"连锁": "允许当前条目的内容触发更多条目"
			}
		},
		{
			id: "triggers#",
			name: "触发词",
			title: "以英文逗号分隔多个关键词，不区分大小写，空格将会被删除\n开启「正则」后直接写正则表达式",
			placeholder: "幻想乡, 博丽神社, 雾雨魔理沙",
			type: "textbox"
			// 非常建议使用工具调用方案
			// 最简单的优点：不再有字符串匹配的语言障碍
		},
		{
			id: "window",
			name: "窗口",
			title: "在过去N条消息中搜索匹配并激活条目\n如果设置为50，激活后将永久保持",
			type: "number",
			min: 1,
			max: 50,
		},
		{
			id: "position",
			name: "插入位置",
			title: "仅字符串匹配模式生效，工具调用会忽略该顺序",
			type: "radio",
			required: true,
			choices: {
				"角色定义前": "worldInfoBefore",
				"角色定义后": "worldInfoAfter",
				"上条消息": "lastMessage",
			}
		},
		{
			id: "id",
			name: "工具ID",
			title: "看不懂就别动这条\n为防止重复，我使用随机生成的ID作为工具调用中的枚举约束，如果可以，请把ID换成描述性字符串，这可以节约token并减少注意力浪费，但需要确保ID在所有激活的世界书中不重复",
			type: "input"
		},
	]);
}

/**
 *
 * @param {Map<Function, any>} handler
 * @param {string} textFieldName
 * @return {[import("unconscious").Renderable,VirtualList]}
 */
function createTextList(handler, textFieldName) {
	const dirtyHandle = $state({}, false, handler);

	const list = <ul />;
	const virtualList = new VirtualList({
		element: list,
		itemHeight: 49,
		renderer(item, index) {
			item[SORT] = index + 1;
			return <li>
				<div className={"summary"}>
					<span className="index">{index + 1}</span>
					<span className="name">{item.content.substring(0, 50)}</span>
					<button
						className="preset-panel__edit-btn"
						onClick={() => {
							item[EXPANDED] ^= true;
							virtualList.setItem(index, item);
						}}
						title="编辑/展开"
					>
						<i className={item[EXPANDED]?`ri-arrow-up-s-line`:`ri-arrow-down-s-line`}></i>
					</button>
					<button
						className="preset-panel__delete-btn"
						onClick={() => {
							const confirm = () => {
								virtualList.items.splice(index, 1);
								markDirty(dirtyHandle);
								virtualList.render();
							};

							const content = item.content;
							if (!content) {
								confirm();
							} else {
								SimpleModal({
									title: "确认删除",
									message: content,
									accent: 'danger',
									onConfirm: confirm
								});
							}
						}}
						title="删除"
					>
						<i className="ri-delete-bin-line"></i>
					</button>
				</div>
				{item[EXPANDED] ? (
					<Filter choices={item} config={[
						{
							name: textFieldName,
							id: "content",
							type: "textbox"
						},
						{
							name: "序号",
							id: SORT,
							type: "number",
							min: 1,
							max: virtualList.items.length
						}
					]} onChange={(k, v, obj) => {
						if (k === SORT) {
							const items = virtualList.items;
							items.splice(index, 1);
							items.splice(v-1, 0, item);
							virtualList.setItems(items);
							return true;
						}
					}} isMobile={true} />
				) : null}
			</li>;
		}
	});

	return [list, virtualList];
}
//endregion

export function createPanel(constructor) {
	const isOpen = $state(false);
	let self;

	const open = (preset) => {
		if (!self) document.body.append(self = constructor(preset, isOpen, close));
		requestAnimationFrame(() => {
			isOpen.value = true;
		});
	};
	const close = () => {
		isOpen.value = false;
		setTimeout(() => {
			if (!isOpen.value) {
				self?.remove();
				self = null;
			}
		}, 300);
	};

	return {open, close};
}

/**
 * 预设编辑面板
 * @param {import("unconscious").Reactive<AiChat.DnD.MyPreset>} preset
 * @param {import("unconscious").Reactive<boolean>} isOpen
 * @param {Function} close
 * @return {import("unconscious").Renderable}
 */
export function _PresetEditor(preset, isOpen, close) {
	const [promptEL, promptVL] = createList(preset, [
		{
			name: "名称(给人看)",
			id: "name",
			type: "input"
		},
		{
			name: "内容(给AI看)",
			id: "content",
			type: "textbox"
		},
		{
			name: "角色",
			id: "role",
			type: "radio",
			required: true,
			choices: {
				"系统": "system",
				"用户": "user",
				"助手": "assistant"
			}
		},
		{
			name: "属性",
			id: "attr",
			type: "radio",
			choices: {
				"占位符": 'marker',
				"置顶": 'first'
			}
		}
	]);
	const [regexpEL, regexpVL] = createList(preset, [
		{
			name: "名称",
			id: "name",
			type: "input"
		},
		{
			name: "正则",
			id: "search",
			placeholder: "/search/g",
			type: "textbox"
		},
		{
			name: "替换",
			id: "replace",
			placeholder: "$$ $1 $&",
			type: "textbox"
		},
		{
			name: "运行时机",
			id: "stage",
			type: "radio",
			required: true,
			choices: {
				"前端渲染": 'render',
				"后端LM": 'prompt',
				"都": 'all'
			}
		},
		{
			name: "作用深度范围 (50 为无限远)",
			id: "depth",
			type: "range",
			min: 0,
			max: 50
		}
	]);

	$watchWithCleanup(preset, () => {
		promptVL.setItems(preset.prompts || (preset.prompts = []));
		regexpVL.setItems(preset.regexps || (preset.regexps = []));
	});

	const showRegexp = $state();
	return (
		<div className={`preset-panel`} class:open={() => isOpen.value}>
			<div className="header">
				<h2 className="title" title={() => preset.name}>{() => preset.name}</h2>
				<div style={"display:flex;gap:0.5rem"}>
					<button className={() => (showRegexp.value ? "ri-toggle-fill" : "ri-toggle-line")+" btn ghost"}
							title={"切换提示词/正则编辑"}
							onClick={() => {
								showRegexp.value ^= true;
							}}>
						{() => showRegexp.value ? ' 提示' : ' 正则'}
					</button>
					<button className="ri-add-line btn ghost" title={"在开头增加一项"} onClick={() => {
						const vl = showRegexp.value ? regexpVL : promptVL;
						vl.items.unshift({});
						vl.render();
					}}>
					</button>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"}
							onClick={close}></button>
				</div>
			</div>
			{() => showRegexp.value ? regexpEL : promptEL}
		</div>
	);
}

/**
 * 角色卡编辑面板
 * @param {import("unconscious").Reactive<AiChat.DnD.MyCharacter>} char
 * @param {import("unconscious").Reactive<boolean>} isOpen
 * @param {Function} close
 * @return {import("unconscious").Renderable}
 */
export function _CharacterEditor(char, isOpen, close) {
	const config = [
		{
			name: "名称",
			id: "name",
			type: "input"
		},
		{
			name: "前置系统提示",
			id: "systemPrompt",
			type: "textbox"
		},
		{
			name: "描述 (*)",
			id: "description",
			type: "textbox"
		},
		{
			name: "性格",
			id: "personality",
			placeholder: "旧字段，可以留空",
			type: "textbox"
		},
		{
			name: "场景",
			id: "scenario",
			placeholder: "旧字段，可以留空",
			type: "textbox"
		}
	];
	const charOptions = <Filter choices={char} config={config} isMobile={true} onChange={(k, v, chr) => {
		markDirty(char);
	}} />;

	// 他妈的，怎么又加内部API了，$state(object, deep, listenerMap)的第三个参数就是为这里加的
	const expMsgListener = new Map;
	const greetingListener = new Map;

	const [lorebookEL, lorebookVL] = createLorebookList(char);
	const [expMsgEL, expMsgVL] = createTextList(expMsgListener, "示例消息");
	const [greetingEL, greetingVL] = createTextList(greetingListener, "开场白");

	expMsgListener.set(() => {
		char.dialogueExamples = expMsgVL.items.map((item) => item.content);
		markDirty(char);
	}, null);

	greetingListener.set(() => {
		char.dialogueExamples = greetingVL.items.map((item) => item.content);
		markDirty(char);
	}, null);

	const newItem = (listener, item, index) => $state({ content: item }, false, listener);

	let prev;
	$watchWithCleanup(char, () => {
		charOptions.onSettingsUpdated(char.value === prev, true);
		if (char.value !== prev) {
			greetingVL.setItems((char.greetings || (char.greetings = [])).map(newItem.bind(null, greetingListener)));
			expMsgVL.setItems((char.dialogueExamples || (char.dialogueExamples = [])).map(newItem.bind(null, expMsgListener)));
			lorebookVL.setItems(char.lorebook || (char.lorebook = []));
			prev = char.value;
		}
	});

	const panel = $state(0);
	const els = [charOptions, lorebookEL, expMsgEL, greetingEL];
	const vls = [, lorebookVL, expMsgVL, greetingVL];

	return (
		<div className={`preset-panel`} class:open={() => isOpen.value}>
			<div className="header">
				<h2 className="title" title={() => char.name}>{() => char.name}</h2>
				<div style={"display:flex;gap:0.5rem"}>
					{() => {
						return panel.value ?
							<button className="ri-add-line btn ghost" title={"在开头增加一项"}
									onClick={() => {
										const value = panel.value;
										const vl = vls[value];

										vl.items.unshift(value === 1 ? {
											id: randomId()
										} : newItem(value === 3 ? greetingListener : expMsgListener, ""));
										vl.render();

									}} /> : null;
					}}
					<select onChange={({target}) => {
						panel.value = target.selectedIndex;
					}}>
						<option value={0}>角色信息</option>
						<option value={1}>嵌入世界书</option>
						<option value={2}>示例对话</option>
						<option value={3}>开场白</option>
					</select>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"} onClick={close}></button>
				</div>
			</div>
			{() => els[panel.value]}
		</div>
	);
}

/**
 * 世界书编辑面板构造器
 * @param {import("unconscious").Reactive<AiChat.DnD.MyLorebook>} lorebook
 * @param {import("unconscious").Reactive<boolean>} isOpen
 * @param {Function} close
 * @return {import("unconscious").Renderable}
 */
export function _LorebookEditor(lorebook, isOpen, close) {
	const [itemEL, itemVL] = createLorebookList(lorebook);

	$watchWithCleanup(lorebook, () => {
		itemVL.setItems(lorebook.pages || (lorebook.pages = []));
	});

	return (
		<div className={`preset-panel`} class:open={() => isOpen.value}>
			<div className="header">
				<h2 className="title" title={() => lorebook.name}>{() => lorebook.name}</h2>
				<div style={"display:flex;gap:0.5rem"}>
					<button className="ri-add-line btn ghost" title={"在开头增加一项"} onClick={() => {
						itemVL.items.unshift({
							id: randomId()
						});
						itemVL.render();
					}}>
					</button>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"} onClick={close}></button>
				</div>
			</div>
			{itemEL}
		</div>
	);
}