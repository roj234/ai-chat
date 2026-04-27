import './ConversationList.css';
import {VirtualList} from 'unconscious/ext/VirtualList.js';
import {formatDate} from 'unconscious/ext/Utils.js';
import {$update, $watchWithCleanup} from 'unconscious';
import {deleteConversation, getMessages, updateConversation} from "../database.js";
import {abortCompletion, conversations, isMobile, messages, selectedConversation} from "../states.js";
import {showToast} from "./Toast.js";
import SimpleModal from "./SimpleModal.jsx";
import {BM, convertToBranchMessage} from "../utils/BranchManager.js";
import {exportConversation} from "../data-exchange.js";
import {onLoad} from "../plugin.js";
import "/plugins/st/STTagList.css";

//const searchText = $state("");

let currentTarget;

const closeHoverMenu = ({target}) => {
	if (currentTarget !== target) {
		hoverMenu.replaceWith(currentTarget);
		currentTarget = null;
	}
}

const hoverMenu = <div className={"tag-dropdown"} style={"position:absolute"}>
	<div className="list" style={"display:block;left:-50%"}>
		<label data-action={"edit"}>编辑标题</label>
		<label data-action={"export"}>导出</label>
		<label data-action={"delete"}>删除</label>
	</div>
</div>;

onLoad((app) => {
	if (!isMobile) hoverMenu.addEventListener("mouseleave", closeHoverMenu);
	app.addEventListener("click", closeHoverMenu);
});

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

	function eventHandler(e) {
		const target = e.target;
		const owner = target.closest('.chat-item');
		if (!owner) return;

		if (abortCompletion.value) {
			showToast("正在生成响应");
			return;
		}

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
					break;
				case "export":
					exportConversation(false, conv);
				break;
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
				break;
			}
		}


		const active = list.querySelector(".active");
		if (active) active.classList.remove('active');
		owner.classList.add('active');

		conv.ready = false;
		selectedConversation.value = conv;
	}

	const mouseHandler = ({target}) => {
		currentTarget = target;
		target.replaceWith(hoverMenu);
	};

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

			const btn = <button className={"edit-btn " + ("ri-more-line")} title={"菜单"} />;
			btn.addEventListener(isMobile ? 'click' : 'mouseover', mouseHandler);

			return <div
				_conv={conv}
				className={`chat-item${selectedConversation.value === conv ? ' active' : ''}`}
				title={formatDate("Y-m-d H:i:s", conv.time)}
			>
				<span className="chat-title">{conv.title || '无标题'}</span>
				<div className="chat-actions">{btn}</div>
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
			groupAndConvArr.push(<div className="chat-group">
				<div>{groupName}</div></div>);
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