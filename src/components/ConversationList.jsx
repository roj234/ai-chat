import './ConversationList.css';
import {VirtualList} from 'unconscious/common/VirtualList.js';
import {formatDate} from 'unconscious/common/Utils.js';
import {$state, $update, $watchWithCleanup, debugSymbol, ONCE_EVENT, unconscious} from 'unconscious';
import {deleteConversation, getKV, setKV, updateConversation} from "../database.js";
import {conversations, isMobile, messages, runningConversations, selectedConversation} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {exportConversation} from "../data-exchange.js";
import {onLoad} from "../plugin.js";
import "/plugins/rp_basic/TagList.css";

export const updateConversationListUI = $state();
export const LOCKED = debugSymbol("CONV_LOCKED");
let PINNED_ITEMS = new Set;

const closeHoverMenu = (e) => {
	if (hoverMenu.isConnected) {
		requestAnimationFrame(() => hoverMenu.remove(true));
		if (e.target.closest('.tag-dropdown') !== hoverMenu)
			e.stopPropagation();
	}
};

/**
 *
 * @type {import("unconscious").Reactive<number>}
 */
const hoverConversationIndex = $state({});
const hoverMenu = <div className={"tag-dropdown"} style={"position:fixed"}>
	<div className="list" style={"display:block;left:-50%"}>
		<label data-action={"edit"}>编辑标题</label>
		<label data-action={"export"}>导出</label>
		<label data-action={"pin"}>{() => PINNED_ITEMS.has(unconscious(hoverConversationIndex)) ? "取消置顶" : "置顶"}</label>
		{() => unconscious(hoverConversationIndex) ? <label data-action={"delete"}>删除</label> : null}
	</div>
</div>;

onLoad((app) => {
	app.addEventListener("click", closeHoverMenu, {capture: true});
	getKV("pinned").then(value => PINNED_ITEMS = new Set(value));
});

const GROUP_LABELS = ["置顶", "今天", "昨天", "7天内", "30天内"];
// 分组逻辑：基于时间戳计算相对日期
const groupConversations = () => {
	const today = new Date().setHours(0, 0, 0, 0);
	const yesterday = today - 86400000;
	const sevenDaysAgo = today - 7 * 86400000;
	const thirtyDaysAgo = today - 30 * 86400000;

	const groups = new Map;

	// idb sorted this
	conversations.forEach(conv => {
		let name;

		if (PINNED_ITEMS.has(conv.id)) {
			name = 0;
		} else {
			const date = new Date(conv.time);
			const timestamp = date.setHours(0, 0, 0, 0);
			if (timestamp === today) {
				name = 1;
			} else if (timestamp === yesterday) {
				name = 2;
			} else if (timestamp > sevenDaysAgo) {
				name = 3;
			} else if (timestamp > thirtyDaysAgo) {
				name = 4;
			} else {
				name = date.getFullYear()+"-"+(date.getMonth()+1);
			}
		}

		const group = groups.get(name);
		if (!group) groups.set(name, [conv]);
		else group.push(conv);
	});

	return groups;
};

/**
 * 渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 * @param {Object} props
 * @param {Conversation[]} props.conversations - 对话数组
 * @param {import("unconscious").Reactive<Conversation>} [props.selectedConversation] - 当前激活的对话ID，用于添加active类
 */
export const ConversationList = (/*{ conversations, selectedConversation, messages }*/) => {
	let skipNext;

	const eventHandler = e => {
		const target = e.target;
		const owner = target.closest('.chat-item');
		if (!owner) return;

		/** @type {AiChat.Conversation} */
		const conv = owner._conv;

		let test = target.closest('label');
		if (test) {
			switch (test.dataset.action) {
				case "pin":
					if (!PINNED_ITEMS.delete(conv.id)) {
						PINNED_ITEMS.add(conv.id);
					}
					setKV("pinned", PINNED_ITEMS.size ? [...PINNED_ITEMS] : undefined);
					$update(conversations);
					$update(hoverConversationIndex);
					return;
				case "edit":
					SimpleModal({
						type: "input",
						title: "请输入新标题",
						value: conv.title,
						onConfirm(val) {
							if (!val) return false;
							const id = vl.findIndex(conv);

							conv.title = val;
							// 重新计算时间
							$update(conversations);
							updateConversation(conv);

							vl.setItem(id, conv);
						}
					});
				return;
				case "export":
					exportConversation(false, conv);
				return;
				case "delete":
					SimpleModal({
						message: '确认删除"'+conv.title+'"#'+conv.id+'？',
						accent: 'danger',
						confirmMessage: '删除',
						onConfirm() {
							let id = vl.findIndex(conv);
							const prev = groupAndConvArr[id-1];
							const next = groupAndConvArr[id+1];
							if (null == prev.id && null == next?.id) {
								groupAndConvArr.splice(id-1, 2);
							} else {
								groupAndConvArr.splice(id, 1);
							}
							vl.resize();

							const start = conversations.indexOf(conv);
							if (start >= 0) {
								conversations.splice(start, 1);
								deleteConversation(conv);
							}

							if (selectedConversation.value === conv) {
								selectedConversation.value = null;
								messages.value = [];
							}
						}
					});
				return;
			}
		}

		const active = list.querySelector(".active");
		if (active) active.classList.remove('active');
		owner.classList.add('active');

		const val = runningConversations.get(conv.id);
		if (val) {
			messages.value = val.messages;
		} else {
			conv.ready = false;
		}

		skipNext = 1;
		selectedConversation.value = conv;
	};

	const mouseHandler = (e) => {
		const closest = e.target.closest('.chat-item');
		if (closest === hoverMenu.closest('.chat-item')) return;
		closest.addEventListener("mouseleave", closeHoverMenu, ONCE_EVENT);
		hoverConversationIndex.value = closest._conv.id;

		hoverMenu.style.left = e.pageX+"px";
		hoverMenu.style.top = e.pageY+"px";
		e.target.append(hoverMenu);
		e.stopPropagation();
	};
	const b2i = (n) => n ? 1 : 0;
	const keyFunc = conv => conv.textContent ?? conv.id + "\0" + conv.title + "\0" + b2i(conv[LOCKED]) + b2i(runningConversations.has(conv.id));

	const list = <div className="sidebar-list scroll" id="chatList" onClick={eventHandler}></div>;
	const groupAndConvArr = [];
	const vl = new VirtualList({
		element: list,
		itemHeight: 36+8,
		gap: 8,
		data: groupAndConvArr,
		keyFunc,
		renderer(conv) {
			if (conv.nodeType) return conv;

			const btn = conv.id === 0 ? <button className="ri-folder-transfer-fill" title={"文件传输助手"}/> : <button className={"edit-btn ri-menu-line"} title={"菜单"} />;
			btn.addEventListener(isMobile ? 'click' : 'mouseover', mouseHandler);

			return <div
				_conv={conv}
				className={`chat-item${unconscious(selectedConversation) === conv ? ' active' : ''}`}
				title={formatDate("Y-m-d H:i:s", conv.time)}
			>
				{runningConversations.has(conv.id) && <span className={"spinner"} />}
				{conv[LOCKED] && <span className="ri-lock-line" title={"其它端正在编辑"} />}
				<span className="chat-title">{conv.title || '无标题'}</span>
				{btn}
			</div>;
		}
	});

	$watchWithCleanup(updateConversationListUI, () => {
		const conv = unconscious(selectedConversation);
		if (conv) {
			const newTime = conv.time;
			const newConv = conversations[0];
			if (newTime > newConv.time) {
				let index = conversations.indexOf(conv);
				if (index >= 0) conversations.splice(index, 1);
				conversations.unshift(conv);
			}
		}

		vl.render();
	});

	$watchWithCleanup(conversations, () => {
		groupAndConvArr.length = 0;

		const groups = groupConversations();
		for (const [k, v] of [...groups].sort(([ka], [kb]) => ka - kb)) {
			groupAndConvArr.push(<div className="chat-group"><div>{GROUP_LABELS[k] || k}</div></div>);
			groupAndConvArr.push(...v);
		}
		vl.render();
	}, false);

	$watchWithCleanup(selectedConversation, () => {
		if (skipNext) {
			skipNext--;
			return;
		}

		const conv = unconscious(selectedConversation);
		vl.dom.querySelector(".active")?.classList.remove("active");
		if (conv) {
			const id = vl.findIndex(conv);
			if (id >= 0) vl.getValue(id).classList.add("active");
		}
	}, false);

	return list;
};