import "./STPresetPanel.css";
import {$computed, $state, $update, $watchWithCleanup, debugSymbol} from "unconscious";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {VirtualList} from "unconscious/ext/VirtualList.js";
import Filter from "unconscious/ext/components/Filter.jsx";
import {highlightJsonLike} from "../../src/markdown/highlight.js";

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
 * @param {Function=} onUpdate
 * @return {[import("unconscious").Renderable, VirtualList]}
 */
function createList(dirtyHandle, config, onUpdate) {
	const list = <ul onClick.delegate{"input[type=checkbox]"}={({delegateTarget}) => {
		if (!delegateTarget) return;

		const key = delegateTarget.closest("li")._key;
		key.enabled = !key.enabled;

		markDirty(dirtyHandle);
		$update(dirtyHandle);
	}} />;

	function createFilter(item, index) {
		const filter = <Filter choices={item} config={[
			...config,
			{
				name: "序号",
				id: SORT,
				type: "number",
				min: 1,
				max: virtualList.items.length
			}
		]} onChange={(k, v, obj, el) => {
			markDirty(dirtyHandle);
			if (k === SORT) {
				const items = virtualList.items;
				items.splice(index, 1);
				items.splice(v - 1, 0, item);
				virtualList.setItems(items);
				return true;
			}
			onUpdate?.(k, v, obj, el);
		}} showTitle={true} fillPlaceholder={false} />;
		filter.onSettingsUpdated(true);
		return filter;
	}

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
				{item[EXPANDED] ? createFilter(item, index) : null}
			</li>;
		}
	});

	return [list, virtualList];
}

const TRIGGER = debugSymbol("TRIGGER");
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
				"向量化": "rag",
			},
			title: {
				"正则": "开启后，触发词将作为正则表达式处理，能匹配更复杂的模式。",
				"常驻": "不依赖触发词，对话一开始就自动加入背景，适合全局性设定（如世界观基调）。",
				"向量化": "基于嵌入向量和输入的余弦相似度判断"
			}
		},
		{
			id: "cossim",
			name: "余弦相似度阈值",
			type: "number",
			min: 0,
			max: 1,
			step: 0.01
		},
		{
			id: "recursion",
			name: "连锁（未实现）",
			type: "radio",
			choices: {
				"能被连锁激活": true,
				"只被连锁激活": "only",
				"连锁到此为止": "stop",
			},
			title: {
				"能被连锁激活": "该条目能被其它条目中的关键词激活",
				"只被连锁激活": "该条目只能被其它条目激活",
				"连锁到此为止": "该条目不能触发其它条目"
			}
		},
		{
			id: TRIGGER,
			name: "触发词",
			title: "每行一个关键词，不区分大小写，空格将会被删除\n开启「正则」后直接写正则表达式",
			placeholder: "幻想乡\n博丽神社\n雾雨魔理沙",
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
				"深度@N": "depth",
			}
		},
		{
			id: "depth",
			name: "深度",
			type: "number",
			title: "插入到倒数第N条消息的末尾",
			min: 1,
			max: 50,
		},
		{
			id: "role",
			name: "消息角色",
			ttile: "不选为任意",
			type: "radio",
			choices: {
				"助手": "assistant",
				"用户": "user",
			},
		},
		{
			id: "id",
			name: "工具ID",
			title: "看不懂就别动这条\n为防止重复，我使用随机生成的ID作为工具调用中的枚举约束，如果可以，请把ID换成描述性字符串，这可以节约token并减少注意力浪费，但需要确保ID在所有激活的世界书中不重复",
			type: "input"
		},
	], (k, v, obj, el) => {
		if (k === TRIGGER) {
			if (obj.regex) {
				try {
					new RegExp(v);
				} catch (e) {
					return e;
				}
				obj.triggers = [v];
			} else {
				obj.triggers = v.split("\n").map(item => item.trim()).filter(item => item);
			}
		}
		if (k === "constant") {
			const querySelector = el.querySelector("[data-id=\"window\"]");
			querySelector.previousElementSibling.style.display = v ? "none" : "";
			querySelector.style.display = v ? "none" : "";
			el.querySelector("[data-id=\"id\"]").style.display = v ? "none" : "";
			el.querySelector("[data-id=\"recursion\"]").style.display = v ? "none" : "";
			if (v) {
				delete obj[TRIGGER];
				delete obj.recursion;
			}
		}
		if (k === "position") {
			const hide = v !== "depth";
			el.querySelector("[data-id=\"depth\"]").style.display = hide ? "none" : "";
			el.querySelector("[data-id=\"role\"]").style.display = hide ? "none" : "";
			if (hide) {
				delete obj.depth;
				delete obj.role;
			}
		}
		if (k === "rag") {
			el.querySelector("[data-id=\"cossim\"]").style.display = !v ? "none" : "";
		}
	});
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
					}} showTitle={true} />
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

	$watchWithCleanup($computed(() => preset.value), () => {
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
						{() => showRegexp.value ? ' 正则' : ' 提示'}
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
	const charOptions = <Filter choices={char} config={config} showTitle={true} onChange={(k, v, chr) => {
		markDirty(char);
	}} />;

	// 他妈的，怎么又加内部API了，$state(object, deep, listenerMap)的第三个参数就是为这里加的
	const expMsgListener = new Map;
	const greetingListener = new Map;

	const [lorebookEL, lorebookVL] = createLorebookList(char);
	const [expMsgEL, expMsgVL] = createTextList(expMsgListener, "示例消息");
	const [greetingEL, greetingVL] = createTextList(greetingListener, "开场白");
	const [autoMessageEL, autoMessageVL] = createList(char, [
		{
			id: "name",
			name: "名称(给人看)",
			type: "input"
		},
		{
			id: "content",
			name: "内容(给AI看)",
			type: "textbox"
		},
		{
			id: "depth",
			name: "深度",
			title: "在多少条消息前插入内容 (0为刚发送的)",
			type: "number",
			min: 0,
			max: 20,
		},
	]);

	expMsgListener.set(() => {
		char.dialogueExamples = expMsgVL.items.map((item) => item.content);
		markDirty(char);
	}, null);

	greetingListener.set(() => {
		char.greetings = greetingVL.items.map((item) => item.content);
		markDirty(char);
	}, null);

	const newItem = (listener, item, index) => $state({ content: item }, false, listener);

	$watchWithCleanup($computed(() => char.value), () => {
		charOptions.onSettingsUpdated(false, true);
		greetingVL.setItems((char.greetings || (char.greetings = [])).map(newItem.bind(null, greetingListener)));
		expMsgVL.setItems((char.dialogueExamples || (char.dialogueExamples = [])).map(newItem.bind(null, expMsgListener)));
		const arr = char.lorebook || (char.lorebook = []);
		arr.forEach(item => item[TRIGGER] = item.triggers.join("\n"));
		lorebookVL.setItems(arr);
		autoMessageVL.setItems(char.autoMessages || (char.autoMessages = []));
	});

	const panel = $state(0);
	const els = [charOptions, lorebookEL, expMsgEL, greetingEL, autoMessageEL];
	const vls = [, lorebookVL, expMsgVL, greetingVL, autoMessageVL];

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

										vl.items.unshift(value === 1 ? lorebookTemplate() : newItem(value === 3 ? greetingListener : expMsgListener, ""));
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
						<option value={4}>背景消息</option>
					</select>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"} onClick={close}></button>
				</div>
			</div>
			{() => els[panel.value]}
		</div>
	);
}

function lorebookTemplate() {
	return {
		id: randomId(),
		rag: false,
		position: "worldInfoAfter",
		window: 5
	}
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

	$watchWithCleanup($computed(() => lorebook.value), () => {
		const arr = lorebook.pages || (lorebook.pages = []);
		arr.forEach(item => item[TRIGGER] = item.triggers?.join("\n"));
		itemVL.setItems(arr);
	});

	return (
		<div className={`preset-panel`} class:open={() => isOpen.value}>
			<div className="header">
				<h2 className="title" title={() => lorebook.name}>{() => lorebook.name}</h2>
				<div style={"display:flex;gap:0.5rem"}>
					<button className="ri-add-line btn ghost" title={"在开头增加一项"} onClick={() => {
						itemVL.items.unshift(lorebookTemplate());
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