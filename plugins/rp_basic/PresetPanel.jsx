import "./PresetPanel.css";
import {$computed, $state, $update, $watchWithCleanup, debugSymbol, unconscious} from "unconscious";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {VirtualList} from "unconscious/common/VirtualList.js";
import Filter from "unconscious/common/components/Filter.jsx";
import {highlightJsonLike} from "/src/markdown/highlight.js";

const EXPANDED = debugSymbol("EXPANDED");
const SORT = debugSymbol("SORT");

export function markDirty(preset) {
	preset._dirty = '*';
	preset.time = Date.now();
}

function handleDelete(virtualList, item, dirtyHandle) {
	const start = virtualList.findIndex(item);
	if (start < 0) return;
	virtualList.items.splice(start, 1);
	markDirty(dirtyHandle);
	virtualList.render();
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
				const index = virtualList.findIndex(item);
				items.splice(index, 1);
				items.splice(v-1, 0, item);
				virtualList.setItems(items);
				return true;
			}
			onUpdate?.(k, v, obj, el);
		}} showTitle={true} fillPlaceholder={false} />;
		filter.sync(true);
		return filter;
	}

	const virtualList = new VirtualList({
		element: list,
		itemHeight: 49,
		keyFunc(item, index) {
			item[SORT] = index + 1;
			return index;
		},
		renderer(item, index) {
			return <li _key={item}>
				<div className={"summary"}>
					<span className="index">{index + 1}</span>
					<span className="name" title={item.name}>{item.name}</span>
					<input
						className="switch"
						type="checkbox"
						checked={item.enabled}
					/>
					<button
						className="preset-panel__edit-btn"
						onClick={() => {
							item[EXPANDED] ^= true;
							virtualList.setItem(index, item);
						}}
						title="编辑/展开"
					>
						<i className={item[EXPANDED] ? `ri-arrow-up-s-line` : `ri-arrow-down-s-line`}></i>
					</button>
					<button
						className="preset-panel__delete-btn"
						onClick={() => {
							SimpleModal({
								title: "确认删除",
								message: <div dangerouslySetInnerHTML={highlightJsonLike(item)}/>,
								accent: 'danger',
								onConfirm() {
									handleDelete(virtualList, item, dirtyHandle);
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
			required: true,
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
			required: true,
			placeholder: "幻想乡是人类与妖怪共存的秘境，四季分明，由博丽神社的巫女维持平衡。外界人偶尔会误入。",
			type: "textbox"
		},
		{
			name: "属性",
			type: "multiple",
			choices: {
				"正则": "regex",
				"常驻": "constant",
			},
			title: {
				"正则": "开启后，触发词将作为正则表达式处理，能匹配更复杂的模式。",
				"常驻": "不依赖触发词，对话一开始就自动加入背景，适合全局性设定（如世界观基调）。",
			}
		},
		{
			id: "recursion",
			name: "连锁",
			type: "radio",
			required: true,
			choices: {
				"能被连锁激活": true,
				"不被连锁激活": false,
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
		},
		{
			id: "window",
			name: "窗口",
			title: "在过去N条消息中搜索匹配并激活条目\n如果设置为0，激活后将永久保持",
			type: "number",
			min: 0,
			max: 50,
		},
		{
			id: "position",
			name: "插入位置",
			title: "仅正则匹配实现生效（被动注入），其它实现由模型主动激活，忽略该设定",
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
			title: "插入到倒数第N条[角色]消息的末尾\n先按角色过滤，再按深度过滤\n没有这么多[角色]消息时，插到系统提示的末尾",
			min: 1,
			max: 50,
		},
		{
			id: "role",
			name: "消息角色",
			title: "不选为任意",
			type: "radio",
			choices: {
				"助手": "assistant",
				"用户": "user",
			},
		},
	], (k, v, obj, el) => {
		if (k === 'regex') {
			if (obj.constant) throw "正则不能和常驻同时开启";
		}

		if (k === TRIGGER) {
			if (obj.regex) {
				try {
					new RegExp(v);
				} catch (e) {
					throw e;
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
			el.querySelector("[data-id=\"recursion\"]").style.display = v ? "none" : "";
			if (v) {
				delete obj.regex;
				delete obj[TRIGGER];
				delete obj.recursion;
				el.sync(false, true);
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
		keyFunc(item, index) {
			item[SORT] = index + 1;
			return index;
		},
		renderer(item, index) {
			return <li>
				<div className={"summary"}>
					<span className="index">{index + 1}</span>
					<span className="name">{item.content.slice(0, 50)}</span>
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
							const confirm = () => handleDelete(virtualList, item, dirtyHandle);

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
							const index = virtualList.findIndex(item);
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
			required: true,
			type: "input"
		},
		{
			name: "内容(给AI看)",
			id: "content",
			required: true,
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
			required: true,
			type: "input"
		},
		{
			name: "正则",
			id: "search",
			required: true,
			placeholder: "使用 /search/g 语法指定修饰符",
			type: "textbox"
		},
		{
			name: "替换",
			id: "replace",
			placeholder: "支持 $$ $1 $& 等高级语法",
			type: "textbox"
		},
		{
			name: "作用域",
			id: "stage",
			type: "radio",
			required: true,
			choices: {
				"渲染": 'render',
				"提示词": 'prompt',
				"都": 'all'
			}
		},
		{
			name: "作用深度 (50 为无限远)",
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
					<button className={() => (unconscious(showRegexp) ? "ri-toggle-fill" : "ri-toggle-line")+" btn ghost"}
							title={"切换提示词/正则编辑"}
							onClick={() => {
								showRegexp.value ^= true;
							}}>
						{() => unconscious(showRegexp) ? ' 正则' : ' 提示'}
					</button>
					<button className="ri-add-line btn ghost" title={"在开头增加一项"} onClick={() => {
						const vl = unconscious(showRegexp) ? regexpVL : promptVL;
						vl.items.unshift({});
						vl.render();
					}}>
					</button>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"}
							onClick={close}></button>
				</div>
			</div>
			{() => unconscious(showRegexp) ? regexpEL : promptEL}
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
			name: "显示名称",
			title: "在数据库和UI中显示的名称，不是卡的自我认知",
			required: true,
			id: "name",
			type: "input"
		},
		{
			name: "角色名字",
			id: "char",
			placeholder: "{{char}} 宏的值；缺省取显示名称",
			type: "input"
		},
		{
			name: "描述",
			required: true,
			id: "description",
			type: "textbox"
		},
		{
			name: "你的名字",
			id: "user",
			placeholder: "{{user}} 宏的值；缺省使用全局设置",
			type: "input"
		},
		{
			name: "自我介绍",
			id: "userdesc",
			placeholder: "缺省使用全局设置",
			type: "textbox"
		},
		{
			name: "作者",
			id: "creator",
			type: "input"
		},
		{
			name: "作者的话",
			id: "creatorNotes",
			type: "textbox"
		},
		{
			name: "前置系统提示",
			id: "systemPrompt",
			placeholder: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
			type: "textbox"
		},
		{
			name: "性格",
			id: "personality",
			placeholder: "旧字段，建议留空",
			type: "textbox"
		},
		{
			name: "场景",
			id: "scenario",
			placeholder: "旧字段，建议留空",
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
		charOptions.sync(false, true);
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