import './ConversationList.css';
import {VirtualList} from 'unconscious/common/VirtualList.js';
import {formatDate} from 'unconscious/common/Utils.js';
import {$state, $update, $watchWithCleanup, debugSymbol, unconscious} from 'unconscious';
import {deleteConversation, updateConversation} from "../database.js";
import {conversations, isMobile, messages, runningConversations, selectedConversation} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {exportConversation} from "../data-exchange.js";
import {onLoad} from "../plugin.js";
import "/plugins/rp_basic/TagList.css";

export const updateConversationListUI = $state();
export const LOCKED = debugSymbol("CONV_LOCKED");

const closeHoverMenu = (e) => {
	if (hoverMenu.isConnected) {
		requestAnimationFrame(() => hoverMenu.remove());
		if (e.target.closest('.tag-dropdown') !== hoverMenu)
			e.stopPropagation();
	}
};

const hoverMenu = <div className={"tag-dropdown"} style={"position:fixed"}>
	<div className="list" style={"display:block;left:-50%"}>
		<label data-action={"edit"}>编辑标题</label>
		<label data-action={"export"}>导出</label>
		<label data-action={"delete"}>删除</label>
	</div>
</div>;

onLoad((app) => {
	if (!isMobile) hoverMenu.addEventListener("mouseleave", closeHoverMenu);
	app.addEventListener("click", closeHoverMenu, {capture: true});
});

// 分组逻辑：基于时间戳计算相对日期
const groupConversations = () => {
	const today = new Date().setHours(0, 0, 0, 0);
	const yesterday = today - 86400000;
	const sevenDaysAgo = today - 7 * 86400000;
	const thirtyDaysAgo = today - 30 * 86400000;

	const groups = {};

	// idb sorted this
	conversations.forEach(conv => {
		const date = new Date(conv.time);
		const timestamp = date.setHours(0, 0, 0, 0);
		let name;
		if (timestamp === today) {
			name = "今天";
		} else if (timestamp === yesterday) {
			name = "昨天";
		} else if (timestamp > sevenDaysAgo) {
			name = "7天内";
		} else if (timestamp > thirtyDaysAgo) {
			name = "30天内";
		} else {
			name = date.getFullYear()+"-"+(date.getMonth()+1);
		}

		groups[name] = groups[name] || [];
		groups[name].push(conv);
	});

	return groups;
};

/**
 * React组件：渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 * @param {Object} props
 * @param {Conversation[]} props.conversations - 对话数组
 * @param {import("unconscious").Reactive<Conversation>} [props.selectedConversation] - 当前激活的对话ID，用于添加active类
 */
export const ConversationList = (/*{ conversations, selectedConversation, messages }*/) => {
	const eventHandler = e => {
		const target = e.target;
		const owner = target.closest('.chat-item');
		if (!owner) return;

		/** @type {AiChat.Conversation} */
		const conv = owner._conv;

		let test = target.closest('label');
		if (test) {
			switch (test.dataset.action) {
				case "edit":
					SimpleModal({
						type: "input",
						title: "请输入新标题",
						message: conv.title,
						onConfirm(val) {
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
							if (!prev.id && !next?.id) {
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

		selectedConversation.value = conv;
	};

	const mouseHandler = (e) => {
		if (e.target.closest('.chat-item') === hoverMenu.closest('.chat-item')) return;
		hoverMenu.style.left = e.pageX+"px";
		hoverMenu.style.top = e.pageY+"px";
		e.target.append(hoverMenu);
		e.stopPropagation();
	};
	const b2i = (n) => n ? 1 : 0;
	const keyFunc = conv => conv.textContent ?? conv.id + "\0" + conv.title + "\0" + b2i(selectedConversation.value === conv) + b2i(conv[LOCKED]) + b2i(runningConversations.has(conv.id));

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

			const btn = <button className={"edit-btn " + ("ri-more-line")} title={"菜单"} />;
			btn.addEventListener(isMobile ? 'click' : 'mouseover', mouseHandler);

			return <div
				_conv={conv}
				className={`chat-item${selectedConversation.value === conv ? ' active' : ''}`}
				title={formatDate("Y-m-d H:i:s", conv.time)}
			>
				{runningConversations.has(conv.id) ? <span className={"spinner"} /> : null}
				{conv[LOCKED] ? <span className="ri-lock-line" title={"其它端正在编辑"} /> : null}
				<span className="chat-title">{conv.title || '无标题'}</span>
				<div className="chat-actions">{btn}</div>
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
		for (const groupName in groups) {
			groupAndConvArr.push(<div className="chat-group"><div>{groupName}</div></div>);
			groupAndConvArr.push(...groups[groupName]);
		}
		vl.resize();
	}, false);

	$watchWithCleanup(selectedConversation, () => {
		const conv = unconscious(selectedConversation);
		if (!conv) {
			vl.dom.querySelector(".active")?.classList.remove("active");
		} else {
			const id = vl.findIndex(conv);
			if (id >= 0) vl.setItem(id, conv);
		}
	}, false);

	return list;
};