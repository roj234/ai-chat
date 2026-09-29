import './ConversationList.css';
import {$state, $update, $watchWithCleanup, debugSymbol, ONCE_EVENT, unconscious} from 'unconscious';
import {ITEM_KEY, VirtualList} from 'unconscious/common/VirtualList.js';
import {formatDate} from 'unconscious/common/Utils.js';
import {deepEqual} from "unconscious/common/deepEqual.js";
import {deleteConversation, updateConversation} from "../database.js";
import {
	auxMainlyTouch,
	conversations,
	LOCKED,
	resetConversation,
	runningConversations,
	selectedConversation,
	switchToConversation,
	updateConversationListUI
} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {exportConversation} from "../data-exchange.js";
import {onLoad} from "../hooks.js";
import "/plugins/rp_basic/TagList.css";
import {showToast} from "./Toast.js";
import {deleteWithDrawback, prettyError} from "../utils/utils.js";

const closeHoverMenu = (e) => {
	if (hoverMenu.isConnected) {
		requestAnimationFrame(() => hoverMenu.remove(true));
		if (e.target.closest('.dropdown') !== hoverMenu)
			e.stopPropagation();
	}
};

/**
 *
 * @type {import("unconscious").Reactive<AiChat.Conversation>}
 */
const hoverConversation = $state({});
const hoverMenu = <div className={"dropdown"} style={"position:fixed;z-index:1"}>
	<div className="list mid" style={"display:block;"}>
		<label data-action={"edit"}>编辑标题</label>
		<label data-action={"export"}>导出</label>
		<label data-action={"pin"}>{() => hoverConversation.meta?.pinned ? "取消置顶" : "置顶"}</label>
		<label data-action={"multi"}>多选</label>
		{() => unconscious(hoverConversation) ? <label data-action={"delete"}>删除</label> : null}
	</div>
</div>;

onLoad((app) => {
	app.addEventListener("click", closeHoverMenu, {capture: true});
});

const GROUP_LABELS = ["置顶", "今天", "昨天", "7天内", "30天内"];
// 分组逻辑：基于时间戳计算相对日期
const groupConversations = () => {
	const base = new Date();
	const today = base.setHours(0, 0, 0, 0);
	const yesterday = base.setDate(base.getDate() - 1);
	const sevenDaysAgo = base.setDate(base.getDate() - 5);
	const thirtyDaysAgo = base.setDate(base.getDate() - 23);

	let monthKey = null, monthStart = 0, monthEnd = 0;

	const baseGroups = [];
	const timeGroups = new Map;

	// idb sorted this
	conversations.forEach(conv => {
		if (conv[DELETING]) return;

		let key;

		if (conv.meta?.pinned) {
			key = 0;
		} else {
			const t = conv.time;
			if (t >= today) {
				key = 1;
			} else if (t >= yesterday) {
				key = 2;
			} else if (t >= sevenDaysAgo) {
				key = 3;
			} else if (t >= thirtyDaysAgo) {
				key = 4;
			} else {
				if (t >= monthStart && t < monthEnd) {
					monthKey.push(conv);
				} else {
					const d = new Date(t);
					const y = d.getFullYear(), m = d.getMonth();

					key = y * 12 + m;
					monthStart = new Date(y, m, 1).getTime();
					monthEnd   = new Date(y, m + 1, 1).getTime();

					monthKey = timeGroups.get(key);
					if (!monthKey) timeGroups.set(key, monthKey = [conv]);
					else monthKey.push(conv);
				}
				return;
			}
		}

		(baseGroups[key] ??= []).push(conv);
	});

	return [baseGroups, timeGroups];
};

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {string} title
 * @param {boolean=} skipSync
 */
export const setConversationTitle = (conv, title, skipSync) => {
	conv.title = title;
	$update(updateConversationListUI);
	if (unconscious(selectedConversation) === conv) {
		$update(selectedConversation);
	}
	if (!skipSync) updateConversation(conv);
};

const SELECTED = debugSymbol("SelectedInConversationList");
const DELETING = debugSymbol("DeletePending");

/**
 * 渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 * @param {Object} props
 * @param {Conversation[]} props.conversations - 对话数组
 * @param {import("unconscious").Reactive<Conversation>} [props.selectedConversation] - 当前激活的对话ID，用于添加active类
 */
export const ConversationList = (/*{ conversations, selectedConversation, messages }*/) => {
	let skipNext;
	let inSelectionMode = 0;

	const prependMultiselectControl = () => {
		groupAndConvArr.unshift(<div className={"multiselect-bar"}>
			<button className={"btn ghost"} onClick={e => {
				conversations.forEach(item => item[SELECTED] = 0);
				vl.dom.replaceChildren();
				vl.render();
			}}>清空
			</button>
			<button className={"btn danger"} onClick={e => {
				const ids = conversations.filter(item => item[SELECTED]);
				SimpleModal({
					title: "确认删除选中的 " + ids.length + " 条对话？",
					accent: "danger",
					onConfirm() {
						if (selectedConversation[SELECTED]) resetConversation();
						return Promise.all(ids.map(deleteConversation)).then(() => {
							conversations.value = conversations.value.filter(item => !item[SELECTED]);
						});
					}
				})
			}}>删除
			</button>
			<button className={"btn ghost"} onClick={e => {
				inSelectionMode = 0;
				groupAndConvArr.shift();
				conversations.forEach(item => { delete item[SELECTED]; })
				vl.dom.replaceChildren();
				vl.render();
			}}>退出
			</button>
		</div>);
	};


	const eventHandler = e => {
		const target = e.target;
		const owner = target.closest('.chat-item');
		if (!owner) return;

		/** @type {AiChat.Conversation} */
		const conv = owner._conv;

		let test = target.closest('label');
		if (test) {
			switch (test.dataset.action) {
				case "multi":
					inSelectionMode = 1;
					prependMultiselectControl();
					vl.dom.replaceChildren();
					vl.render();
					return;
				case "pin":
					const meta = conv.meta ??= {};
					if (!meta.pinned) meta.pinned = true;
					else delete meta.pinned;
					updateConversation(conv).then(() => {
						$update(conversations);
						$update(hoverConversation);
					})
					return;
				case "edit":
					SimpleModal({
						type: "input",
						title: "请输入新标题",
						placeholder: "清除标题, 下次对话后重新生成",
						value: conv.title,
						onConfirm(val) {
							setConversationTitle(conv, val);
						}
					});
				return;
				case "export":
					exportConversation(1, conv);
				return;
				case "delete": {
					const pos = conversations.indexOf(conv);
					if (pos < 0) return;

					conv[DELETING] = true;
					$update(conversations);

					let isOpened;
					if (unconscious(selectedConversation) === conv) {
						isOpened = true;
						resetConversation();
					}

					const isKeyboard = e.detail === 0;
					deleteWithDrawback(`${conv.title||'无标题'} (#${conv.id})`, () => {
						deleteConversation(conv).then(() => {
							const noUpdate = unconscious(conversations);
							const pos = noUpdate.indexOf(conv);
							if (pos >= 0) noUpdate.splice(pos, 1);
						}, err => {
							showToast("删除失败\n"+prettyError(err), "error");
							delete conv[DELETING];
							$update(conversations);
						});
					}, () => {
						if (isOpened && unconscious(selectedConversation) == null)
							switchToConversation(conv);

						delete conv[DELETING];
						$update(conversations);
					}, isKeyboard);
				}
				return;
			}
		}

		const active = list.querySelector(".active");
		if (active) active.classList.remove('active');
		owner.classList.add('active');

		switchToConversation(conv);
		skipNext = 1;
	};

	const mouseHandler = (e) => {
		const closest = e.target.closest('.chat-item');
		if (closest === hoverMenu.closest('.chat-item')) return;
		closest.addEventListener("mouseleave", closeHoverMenu, ONCE_EVENT);
		hoverConversation.value = closest._conv;

		hoverMenu.style.left = e.pageX+"px";
		hoverMenu.style.top = Math.min(innerHeight - 180, e.pageY)+"px";
		e.target.append(hoverMenu);
		e.stopPropagation();
	};
	const keyFunc = conv => conv.textContent ?? [conv.id, conv.title, conv[LOCKED]];

	const list = <div className="sidebar-list scroll" onClick={eventHandler} role="list" />;
	const groupAndConvArr = [];
	const vl = new VirtualList({
		element: list,
		itemHeight: 32,
		data: groupAndConvArr,
		keyFunc,
		reuseHook(node, newKey, item) {
			if (!deepEqual(node[ITEM_KEY], newKey)) return false;

			if (Array.isArray(newKey)) {
				node.classList.toggle('spin-before', runningConversations.has(item.id));
			}

			return true;
		},
		renderer(conv) {
			if (conv.nodeType) return conv;

			const btn = conv.id === 0 ? <button className="ri-folder-transfer-fill" title={"文件传输助手"}/> : <button className={"edit-btn ri-menu-line"} title={"菜单"} />;
			btn.addEventListener(auxMainlyTouch ? 'click' : 'mouseover', mouseHandler);
			const running = runningConversations.has(conv.id);

			const owner = conv.meta?.owner;
			// 多选删除 删除未使用的文件
			return <div
				_conv={conv}
				className={`chat-item${running?' spin-before' : ''}${owner?' subagent':''}${unconscious(selectedConversation) === conv ? ' active' : ''}`}
				title={conv.title+" (#"+conv.id+")\n"+formatDate("Y-m-d H:i:s", conv.time)}
				tabIndex={0}
				role="listitem"
			>
				{(!running && inSelectionMode) && <input type={"checkbox"} checked={conv[SELECTED]} onClick.stop={e => {
					conv[SELECTED] = e.target.checked;
				}}/>}
				{conv[LOCKED] && <span className="ri-lock-line" title={"其它端正在编辑"} />}
				<span className="chat-title">{(conv.title || '无标题') + (owner?" for #"+owner:"")}</span>
				{inSelectionMode ? null : btn}
			</div>;
		}
	});
	list.vl = vl;

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

	// 这个函数看起来性能很糟糕，但在十万条对话上 120Hz 更新(每调用 ~8ms)，React拿头跟我打
	$watchWithCleanup(conversations, () => {
		groupAndConvArr.length = 0;

		if (inSelectionMode) prependMultiselectControl();

		const [baseGroups, timeGroups] = groupConversations();
		for (let i = 0; i < 5; i++) {
			const val = baseGroups[i];
			if (val) {
				groupAndConvArr.push(<div className="chat-group"><div>{GROUP_LABELS[i]}</div></div>);
				for (let j = 0; j < val.length; j++) groupAndConvArr.push(val[j]);
			}
		}

		for (const [k, v] of [...timeGroups].sort(([ka], [kb]) => kb - ka)) {
			groupAndConvArr.push(<div className="chat-group">
				<div>{Math.floor(k/12)+'-'+(k%12 + 1)}</div>
			</div>);
			for (let j = 0; j < v.length; j++) groupAndConvArr.push(v[j]);
		}
		vl.render();
	}, false);

	$watchWithCleanup(selectedConversation, () => {
		if (skipNext) {
			skipNext--;
			return;
		}

		const conv = unconscious(selectedConversation);
		vl.dom.querySelectorAll(".active").forEach(item => item.classList.remove("active"));
		if (conv) {
			const id = vl.findIndex(conv);
			if (id >= 0) vl.getValue(id).classList.add("active");
		}
	}, false);

	return list;
};