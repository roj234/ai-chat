import "./MessageFold.css";
import {openWindow} from "/src/components/Windows.jsx";
import {$computed, $state, $update, $vforeach, $watch, AS_IS, ref, unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import {ITEM_KEY} from "unconscious/common/VirtualList.js";
import {messages, selectedConversation} from "/src/states.js";
import {markMessageDirty, updateConversation} from "/src/database.js";
import {enableBranches} from "/src/utils/BranchManager.js";

function MessageFoldManager({conversation, messages, onChange}) {
	const sel = $state({});

	/** 校验 [s, e] 是否与已有 blocks 重叠 */
	const _overlaps = (s, e) => messages.slice(s, e).some(b => b.role === 'fold');
	const _emitChange = () => onChange(conversation, messages);
	const _toast =(msg, isError = false) => showToast(msg, isError ? 'error' : '');

	/* ---------------- 渲染 ---------------- */

	const _renderMessages = (row, i)=> {
		row.firstElementChild.dataset.id = i;

		row.classList.remove('selecting', 'edge');
		if (sel.start != null) {
			const s = Math.min(sel.start, sel.end ?? sel.start);
			const e = Math.max(sel.start, sel.end ?? sel.start);
			if (i >= s && i <= e) {
				row.classList.add('selecting');
				if (i === sel.start || i === sel.end) row.classList.add('edge');
				return
			}
		}

		if (row.classList.contains("in-block")) return;

		row.firstElementChild.textContent = i;
	};

	const selectState = $computed(() => {
		let hintContent;
		let canCreate = false;
		let showClear = true;

		if (sel.start == null) {
			hintContent = <span className="mb-hint">点选<b>起始</b>消息</span>;
			showClear = false;
		} else if (sel.end == null) {
			hintContent = <span className="mb-hint">已选起始 <b>#{sel.start}</b>，继续点选<b>结束</b>消息</span>;
		} else {
			const s = Math.min(sel.start, sel.end);
			const e = Math.max(sel.start, sel.end);

			hintContent = <span className="mb-hint">已选 {e - s + 1} 条<b>#{s} - #{e}</b>{sel.overlap && <span className="error">所选范围内包含压缩块，确保你知道你在做什么</span>}</span>;
			canCreate = true;
		}

		return [hintContent, showClear, canCreate];
	})

	/** 局部刷新（保留滚动位置） */
	$watch(sel, () => $update(messages), false);

	/* ---------------- 交互逻辑 ---------------- */

	const _onMsgClick = (event) => {
		const delegateTarget = event.delegateTarget;

		delegateTarget.classList.toggle("open");

		const index = parseInt(delegateTarget.firstElementChild.dataset.id, 10);
		if (delegateTarget.classList.contains('in-block')) {
			if (event.target !== delegateTarget && event.target !== delegateTarget.firstElementChild) return;
		} else if (delegateTarget.classList.contains('disabled')) {
			return;
		}

		if (sel.start == null) {
			sel.start = index;
		} else if (sel.end == null) {
			// 点击结束点
			if (index === sel.start) {
				// 再次点击同一条 → 取消
				sel.value = {};
			} else {
				const s = Math.min(sel.start, index);
				const e = Math.max(sel.start, index);
				if (_overlaps(s, e)) sel.overlap = true;
				sel.end = index;
			}
		} else {
			sel.value = { start: index };
		}
	}

	const _createBlock = () => {
		const s = Math.min(sel.start, sel.end);
		const e = Math.max(sel.start, sel.end);

		try {
			let bm = enableBranches(unconscious(conversation));
			messages.value = bm;

			bm.fold(s, e, { content: '[Compressed block]' });

			sel.value = {};
			_emitChange();
			_toast(`已创建分块 #${s} - #${e}`);
		} catch (e) {
			_toast(e.message, true);
		}
	}

	let $messages = ref();
	return <>
		<div className="mb-messages" ref={$messages} onClick.delegate{'.mb-msg'}={_onMsgClick}>{$vforeach(messages, (msg, i) => {
			if (msg.id < 0) {
				return <div className="mb-msg disabled">
					<span className="no">{i}</span>
					<div className="body">
						<span className="tag">{msg.role}</span>
						插件数据
					</div>
				</div>;
			}

			if (msg.role === 'fold') {
				return <div className={'mb-msg in-block ' + (msg.disabled ? ' disabled' : '')}>
					<span className='no' data-id={i}>{`#${msg.start} - #${msg.end}`}</span>
					<textarea className="text-input" value={msg.content} placeholder={'压缩块的摘要…'} onChange={({target}) => {
						msg.content = target.value;
						markMessageDirty(msg);
						_emitChange();
					}}/>
					<input
						className="switch"
						type="checkbox"
						title="启用该压缩块"
						checked={!msg.disabled}
						onChange={({target}) => {
							if (target.checked) delete msg.disabled;
							else msg.disabled = true;

							markMessageDirty(msg);
							_emitChange();
							target.closest(".mb-msg").classList.toggle('disabled', !!msg.disabled);
						}}
					/>
					<button className='btn danger-focus' onClick={({target}) => {
						unconscious(messages).unfold(msg);
						$update(messages);
						_emitChange();
						target.closest(".mb-msg").remove();
					}}>解压
					</button>
				</div>;
			}

			let text = msg.content;
			let others = [msg.role];

			if (Array.isArray(text)) {
				for (const item of text) {
					if (item.type !== 'text')
						others.push(item.type);
					else {
						text = item.text;
					}
				}
			}

			if (text?.length > 200) text = text.slice(0, 197)+"...";
			if (msg.think) others.push(`已思考${(msg.think.duration / 1000) .toFixed(1)}秒`);
			if (msg.tool_calls) msg.tool_calls.forEach(item => others.push("已运行 "+item.function.name));

			const row = <div className='mb-msg'>
				<span className="no" data-id={i}>{i}</span>
				<div className="body">
					{others.map((t) => (<span className="tag">{t}</span>))}
					{text}
				</div>
			</div>;

			_renderMessages(row, i);
			return row;
		}, AS_IS, {
			reuseHook(node, key, item, i) {
				if (node[ITEM_KEY] !== key) return false;
				_renderMessages(node, i);

				return true;
			}
		})}</div>
		<div className="mb-select-bar">
			{() => selectState[0]}
			<button
				className="btn ghost"
				style:visibility={() => selectState[1] ? 'visible' : 'hidden'}
				onClick={() => {
					sel.value = {};
				}}
			>
				清除选择
			</button>
			<button
				className="btn primary"
				disabled={() => !selectState[2]}
				onClick={() => {
					_createBlock();
				}}
			>
				压缩
			</button>
		</div>
	</>;
}

export const showMessageFolder = () => openWindow({
	id: "messageFolder",
	title: "上下文管理器",
	element: MessageFoldManager({
		conversation: selectedConversation,
		messages: messages,
		onChange: (conversation, messages) => {
			updateConversation(unconscious(conversation), unconscious(messages));
		},
	})
});
