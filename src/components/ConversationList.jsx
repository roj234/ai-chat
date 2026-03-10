import './ConversationList.css';
import {VirtualList} from 'unconscious/ext/VirtualList.js';
import {formatDate} from 'unconscious/ext/Utils.js';
import {$update, $watchWithCleanup} from 'unconscious';
import {deleteConversation, getMessages, updateConversation} from "../database.js";
import {conversations, isMobile, messages, selectedConversation} from "../states.js";
import {abortCompletion} from "../api-request.js";
import {showToast} from "./Toast.js";
import SimpleModal from "./SimpleModal.jsx";
import {BM, convertToBranchMessage} from "../BranchManager.js";

//const searchText = $state("");

/**
 * React组件：渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 * @param {Object} props
 * @param {Conversation[]} props.conversations - 对话数组
 * @param {import("unconscious").Reactive<Conversation>} [props.selectedConversation] - 当前激活的对话ID，用于添加active类
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
				updateConversation(conv);
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

		SimpleModal({
			message: '确认删除"'+conv.title+'"#'+conv.id+'？',
			accent: 'danger',
			confirmMessage: '删除',
			onConfirm() {
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

		if (abortCompletion.value) {
			showToast("正在生成响应");
			return;
		}

		const active = list.querySelector(".active");
		if (active) active.classList.remove('active');
		owner.classList.add('active');

		conv.ready = false;
		selectedConversation.value = conv;
	}

	const list = <div className="sidebar-list scroll" id="chatList" onClick={eventHandler}></div>;
	const groupAndConvArr = [];
	const vl = new VirtualList({
		element: list,
		itemHeight: 36+8,
		gap: 8,
		data: groupAndConvArr,
		keyFunc,
		renderer(conv) {
			if (!conv.id) return conv;
			const isEditing = editingNow === conv;
			return <div
				_conversation={conv}
				className={`chat-item${selectedConversation.value === conv ? ' active' : ''}${isEditing?" hover":''}`}
				title={formatDate("Y-m-d H:i:s", conv.time)}
			>
				<span className="chat-title">{isEditing
					? <input type="text" onKeyDown={(e) => handleKeyDown(e, conv)} className="chat-title-input" value={conv.title}/>
					: conv.title || '无标题'}
				</span>
				{isMobile ? <div className="chat-actions">
					<button className={"delete-btn " + ("ri-more-line")} title={"删除"}></button>
				</div> : <div className="chat-actions">
					<button className={"edit-btn " + (isEditing ? "ri-check-fill" : "ri-edit-2-line")}
							title={editingNow === conv ? "保存" : "编辑"}></button>
					<button className={"delete-btn " + (isEditing ? "ri-forbid-2-line" : "ri-delete-bin-line")} title={editingNow === conv ? "取消" : "删除"}></button>
				</div>}
			</div>;
		}
	});

	function keyFunc(conv) {
		return conv.id ? conv.id + "\0" + conv.title + "\0" + (selectedConversation.value === conv) : conv;
	}

	$watchWithCleanup(conversations, () => {
		groupAndConvArr.length = 0;

		const groups = groupConversations();
		for (const groupName in groups) {
			groupAndConvArr.push(<div className="chat-group"><div>{groupName}</div></div>);
			groupAndConvArr.push(...groups[groupName]);
		}
		vl.resize();
	}, false);

	let dontUpdateFlag;
	$watchWithCleanup(selectedConversation, () => {
		const conv = selectedConversation.value;
		if (conv && !conv.ready) {
			getMessages(conv).then(data => {
				conv.ready = true;

				if (selectedConversation.value === conv) {
					dontUpdateFlag = conv;
					$update(selectedConversation);
					messages.value = conv.branches ? convertToBranchMessage(conv, data) : data;
				}
			});
		}
		if (!conv) {
			vl.dom.querySelector(".active")?.classList.remove("active");
		} else {
			const id = vl.findIndex(conv);
			if (id >= 0) vl.setItem(id, conv);
		}
	}, false);

	// autosave
	$watchWithCleanup(messages, () => {
		const tmp = dontUpdateFlag;
		dontUpdateFlag = null;
		if (selectedConversation.ready) {
			const conv = selectedConversation.value;
			if (conv === tmp) return;

			conv.time = Date.now();
			conversations.sort((a, b) => b.time - a.time);

			updateConversation(conv, conv.branches ? [...conv[BM]] : messages.value);
		}
	}, false);

	return list;
}