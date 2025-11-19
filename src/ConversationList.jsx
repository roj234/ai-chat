import './ConversationList.css';
import {VirtualList} from 'unconscious/ext/VirtualList.js';
import {formatDate} from 'unconscious/ext/Utils.js';
import {$update, $watchWithCleanup} from 'unconscious';
import {deleteConversation, getMessages, setConversation} from "./idb.js";
import {conversations, messages, selectedConversation} from "./states.js";
import {abortCompletion} from "./api-request.js";
import {showToast} from "./Toast.js";

//const searchText = $state("");

/**
 * React组件：渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 * @param {Object} props
 * @param {Conversation[]} props.conversations - 对话数组
 * @param {Reactive<Conversation>} [props.selectedConversation] - 当前激活的对话ID，用于添加active类
 */
export function ConversationList(/*{ conversations, selectedConversation, messages }*/) {
	let editingNow = null;

	// 分组逻辑：基于时间戳计算相对日期
	function groupConversations() {
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
	}

	// 处理点击编辑按钮
	const leftBtnClick = (e, conv) => {
		const id = vl.findIndex(conv);

		if (editingNow === conv) {
			editingNow = null;
			const val = e.target.closest('.chat-item').querySelector('input').value.trim();
			if (val) {
				conv.title = val;
				// 重新计算时间
				$update(conversations);
				setConversation(conv, false);
			}
		} else {
			const oldEditingNow = editingNow;
			editingNow = conv;

			const id1 = oldEditingNow ? vl.findIndex(oldEditingNow) : -1;
			if (id1 > 0) vl.setItem(id1, oldEditingNow);
		}

		vl.setItem(id, conv);
	};

	// 处理删除点击
	const rightBtnClick = (e, conv) => {
		let id = vl.findIndex(conv);

		if (editingNow === conv) {
			editingNow = null;
			vl.setItem(id, conv);
			return;
		}

		if (window.confirm('确认删除"'+conv.title+'"#'+conv.id+'？')) {
			const prev = groupAndConvArr[id-1];
			const next = groupAndConvArr[id+1];
			if (!prev.id && !next?.id) {
				groupAndConvArr.splice(id-1, 2);
			} else {
				groupAndConvArr.splice(id, 1);
			}
			vl.repaint();

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
	};

	// 处理Enter键确认编辑
	const handleKeyDown = (e, conv) => {
		if (e.key === 'Enter') {
			leftBtnClick(e, conv);
		} else if (e.key === 'Escape') {
			rightBtnClick(e, conv);
		}
	};

	function eventHandler(e) {
		const target = e.target;
		const owner = target.closest('.chat-item');
		if (!owner) return;

		const conv = owner._conversation;

		let test = target.closest('.edit-btn');
		if (test) return leftBtnClick(e, conv);

		test = target.closest('.delete-btn');
		if (test) return rightBtnClick(e, conv);

		test = target.closest('.chat-title input');
		if (test) return;

		if (abortCompletion) {
			showToast("正在生成中，请等待结束");
			return;
		}

		const active = list.querySelector(".active");
		if (active) active.classList.remove('active');
		owner.classList.add('active');

		conv.ready = false;
		selectedConversation.value = conv;
	}

	function getChatListItemHeight(element) {
		const style = window.getComputedStyle(element);

		const offsetHeight = element.offsetHeight;
		const marginTop = parseFloat(style.marginTop) || 0;
		const marginBottom = parseFloat(style.marginBottom) || 0;

		return offsetHeight + marginTop + marginBottom + 8;
	}

	const list = <div className="sidebar-list scroll" id="chatList" onClick={eventHandler}></div>;
	const groupAndConvArr = [];
	const vl = new VirtualList({
		element: list,
		itemHeight: 36+8,
		heightOf: getChatListItemHeight,
		data: groupAndConvArr,
		keyFunc,
		renderer: (conv) => {
			if (!conv.id) return conv;
			return <div
				_conversation={conv}
				className={`chat-item${selectedConversation.value === conv ? ' active' : ''}`}
				title={formatDate("Y-m-d H:i:s", conv.time)}
			>
				<span className="chat-title">{editingNow === conv
					? <input type="text" onKeyDown={(e) => handleKeyDown(e, conv)} className="chat-title-input" value={conv.title} />
					: conv.title || '新对话'}</span>
				<div className="chat-actions">
					<button className="edit-btn">{editingNow === conv ? "保存" : "编辑"}</button>
					<button className="delete-btn">{editingNow === conv ? "取消" : "删除"}</button>
				</div>
			</div>;
		}
	});

	function keyFunc(conv) {return conv.id ? conv.id+"\0"+conv.title+"\0"+(selectedConversation.value === conv) : conv;}

	$watchWithCleanup(conversations, () => {
		groupAndConvArr.length = 0;

		const groups = groupConversations();
		for (const groupName in groups) {
			groupAndConvArr.push(<div className="chat-group-header">{groupName}</div>);
			groupAndConvArr.push(...groups[groupName]);
		}
		vl.repaint();
	});

	$watchWithCleanup(selectedConversation, () => {
		const conv = selectedConversation.value;
		if (conv && !conv.ready) {
			getMessages(conv.messageId).then(data => {
				if (selectedConversation.value === conv) {
					messages.value = data.messages;
				}

				// wait for messages to update
				queueMicrotask(() => {
					conv.ready = true;
					$update(selectedConversation);
				});
			});
		}
		if (!conv) {
			vl.dom.querySelector(".active")?.classList.remove("active");
		}
	});

	// autosave
	$watchWithCleanup(messages, () => {
		const conv = selectedConversation.value;
		if (conv?.ready) {
			conv.time = Date.now();
			conversations.sort((a, b) => b.time - a.time);

			setConversation(conv, messages.value);
		}
	});

	return list;
}