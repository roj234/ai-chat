import './ConversationList.css';
import {$update, $watchWithCleanup, debugSymbol, unconscious} from 'unconscious';
import {VirtualList} from 'unconscious/common/VirtualList.js';
import {formatDate} from 'unconscious/common/Utils.js';
import {deleteConversation, setConversationTitle, updateConversation} from "../database.js";
import {
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
import "/plugins/rp_basic/TagList.css";
import {showToast} from "./Toast.js";
import {deleteWithDrawback, prettyError} from "../utils/utils.js";
import {openContextMenu} from "./Menu.js";

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

const SELECTED = debugSymbol("SelectedInConversationList");
const DELETING = debugSymbol("DeletePending");

/**
 * 渲染对话列表，按时间分组，支持选择、编辑标题、删除。
 */
export const ConversationList = () => {
	let inSelectionMode = 0;

	const prependMultiselectControl = () => {
		groupAndConvArr.unshift(<div className={"multiselect-bar"}>
			<button className={"btn ghost"} onClick={e => {
				conversations.forEach(item => item[SELECTED] = 0);
				refreshList();
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
				refreshList();
			}}>退出
			</button>
		</div>);
	};

	const menuHandler = ev => {
		if (inSelectionMode) return;
		ev.preventDefault();

		const conv = (ev.delegateTarget ?? ev.target.closest('.chat-item'))._conv;
		const pinned = conv.meta?.pinned;
		openContextMenu(ev, list, [
			{label: '重命名', icon: "ri-edit-line", act: () => {
					SimpleModal({
						type: "input",
						title: "请输入新标题",
						placeholder: "清除标题, 下次对话后重新生成",
						value: conv.title,
						onConfirm(val) {
							setConversationTitle(conv, val);
						}
					});
				}},
			{label: '导出', icon: "ri-download-line", act: () => exportConversation(1, conv)},
			{label: pinned ? "取消置顶" : "置顶", icon: pinned ? "ri-pushpin-fill" : "ri-pushpin-line", act: () => {
					const meta = conv.meta ??= {};
					if (!meta.pinned) meta.pinned = true;
					else delete meta.pinned;
					updateConversation(conv).then(() => $update(conversations));
				}},
			{ sep: true },
			{label: '多选', icon: "ri-checkbox-multiple-line", act: () => {
					inSelectionMode = 1;
					prependMultiselectControl();
					refreshList();
				}},
			{label: '删除', icon: "ri-delete-bin-line", danger: true, act: () => {
					const pos = conversations.indexOf(conv);
					if (pos < 0) return;

					conv[DELETING] = true;
					$update(conversations);

					let isOpened;
					if (unconscious(selectedConversation) === conv) {
						isOpened = true;
						resetConversation();
					}

					const isKeyboard = ev.detail === 0;
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
				}},
		]);
	}

	const keyFunc = conv => conv.textContent ?? conv.id+"\0"+conv.title+"\0"+(+conv[LOCKED]);

	const list = <div className="sidebar-list scroll" role="list"
	onClick.delegate{".chat-item"}={ev => {switchToConversation(ev.delegateTarget._conv)}}
	onContextMenu.delegate{".chat-item"}={menuHandler} />;

	const groupAndConvArr = [];
	const vl = new VirtualList({
		element: list,
		itemHeight: 32,
		gap: 8,
		data: groupAndConvArr,
		keyFunc,
		onReuse(node, item) {
			if (item.textContent == null) {
				node.classList.toggle('spin-before', runningConversations.has(item.id));
				node.classList.toggle('active', unconscious(selectedConversation) === item);
			}
		},
		renderer(conv) {
			if (conv.nodeType) return conv;

			const running = runningConversations.has(conv.id);

			const owner = conv.meta?.owner;
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
				{inSelectionMode ? null : <button className={"edit-btn ri-menu-line"} title={"菜单"} onClick.stop={menuHandler} />}
			</div>;
		}
	});
	list.vl = vl;

	const refreshList = () => {
		vl.dom.replaceChildren();
		vl.setItems(groupAndConvArr);
	};

	$watchWithCleanup(updateConversationListUI, () => {
		const conv = unconscious(selectedConversation);
		if (conv) {
			const time = conv.time;
			const arr = unconscious(conversations);
			const latest = arr[0];
			if (time > latest.time) {
				let index = arr.indexOf(conv);
				if (index >= 0) arr.splice(index, 1);
				conversations.unshift(conv);

				// 以后可以增量更新什么的
				//const [baseGroups, timeGroups] = groupConversations(groupAndConvArr, conv);
			}
		}

		vl.render();
	}, false);

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
		vl.setItems(groupAndConvArr);
	}, false);

	// 这个函数其实完全多余，调用 vl.render 就会自动更新 active
	$watchWithCleanup(selectedConversation, () => {
		//vl.render(); return;

		vl.dom.querySelectorAll(".active").forEach(item => item.classList.remove("active"));
		const conv = unconscious(selectedConversation);
		if (conv) {
			const id = vl.findIndex(conv);
			if (id >= 0) vl.getValue(id).classList.add("active");
		}
	}, false);

	return list;
};