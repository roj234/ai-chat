import {ThinkBlock} from "./ThinkBlock.jsx";
import {ToolCallCard} from "./ToolCallCard.jsx";
import {$computed, $foreach, $state, $update, $watch, AppendObserver, debugSymbol, unconscious} from "unconscious";
import {formatDate, formatSize} from "unconscious/common/Utils.js";
import {copyCodeEventHandler, renderMarkdownToElement, renderMarkdownToString} from "../markdown/markdown.js";
import {
	abortCompletion,
	config,
	EditableMessageRoles,
	isMobile,
	MessageCopyHandler,
	MessageRoles,
	messages,
	selectedConversation
} from "../states.js";
import {submitUserChatMessage} from "../api-request.js";
import {
	copyButtonAnimation,
	downloadFile,
	errorBlock,
	getTextContent,
	IN_EDIT_MODE,
	loadingBlock,
	MORPH_CHILD_HANDLER,
	prettyError
} from "../utils/utils.js";
import "./MessageList.css";
import {toolScriptRegistry, undoToolCalls} from "../skills.js";
import {getBillingLog} from "../database.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {copyBranchAt, getBranchIndexCount, setBranchIndex, setLastMessage} from "../utils/BranchManager.js";
import {ITEM_KEY, PINNED, VirtualList} from "unconscious/common/VirtualList.js";
import {EditWidget} from "./EditWidget.jsx";
import {AudioPlayer} from "./AudioPlayer.jsx";

import "./MyLoading.jsx";
import morphdom from "morphdom";
import SimpleModal from "./SimpleModal.jsx";
import {ToolCallEditor} from "./ToolCallEditor.jsx";

// region AiChat.ResponseContentPart[] 的生成和渲染函数
/**
 *
 * @param {AiChat.AssistantMessage} m
 * @return {AppendObserver}
 */
function chunkRenderer(m) {
	return $foreach(m.content, (item) => {
		switch (item.type) {
			default: {
				let {error, title} = item;
				if (!error) return errorBlock(item, "AssertError");
				if (typeof error !== "string") error = prettyError(error);
				if (title) return errorBlock(error, title);

				const index = error.indexOf('\n');
				return errorBlock(error.slice(index+1), error.substring(0, index));
			}
			case "html":
				let element = item.html;
				if (typeof element === "function") element = element();
				return typeof element === "string" ? <div dangerouslySetInnerHTML={item.html} /> : element;
			case "loading":
				return loadingBlock(<my-loading text={item.text} />);
			case "input_audio": {
				return <AudioPlayer src={item.input_audio.data} />
			}
			case "text": {
				const {text} = item;
				if (typeof text !== "string") {
					return <details>
						<summary>{text.name || "文本文件"} ({formatSize(text.size)}, {text.type})</summary>
						<a onClick={() => {
							downloadFile(text);
						}}>下载</a>
					</details>
				}
				if (isEditing(m.key)) {
					return <EditWidget value={text} onChange={value => {
						item.text = value;
						const message = m.key;
						if (!Array.isArray(message.content)) {
							message.content = value;
						}
					}} />;
				} else {
					const container = <div className="md" />;
					renderMarkdownToElement(container, text);
					return container;
				}
			}
			case "images":
				return <div className="gallery">{item.images.map(part => {
					const url = part.image_url?.url;
					return url && <img src={url.toUrl?.() || url}/>;
				})}</div>;
			case "think":
				return <ThinkBlock message={item} edit={isEditing(m.key)}/>;
			case "tool_call":
				return isEditing(m.key) ? <ToolCallEditor {...item} /> : <ToolCallCard {...item} />;
			case "tool":
				try {
					let has_successor = item.idx !== messages.length - 1;
					return toolScriptRegistry[item.tool_name].renderer(item.response, has_successor, item.tool);
				} catch (e) {
					console.error(e);
					return errorBlock(e, "工具UI渲染失败");
				}
			case "usage":
				const logData = $state("加载中");

				return (<div className="stats" onMouseEnter.once={() => {
					Promise.all(messages.slice(m.index, m.end_index).map(m => getBillingLog(m.id))).then((logs) => {
						let totalInput = 0;
						let totalCacheRead = 0;
						let totalOutput = 0;
						let totalReasoning = 0;
						let totalCacheWrite = 0;
						let totalCost = 0;
						let totalTime = 0;
						let avgTps = 0;

						logs.forEach(item => {
							if (!item) return;

							let {
								input_tokens = 0, cached_tokens = 0, output_tokens = 0, reasoning_tokens = 0, cache_write_tokens = 0,
								cost = 0, duration = 0, tps
							} = item;

							duration /= 1000;

							totalInput += input_tokens;
							totalCacheRead += cached_tokens;
							totalOutput += output_tokens;
							totalReasoning += reasoning_tokens;
							totalCacheWrite += cache_write_tokens;
							totalCost += cost;
							totalTime += duration;

							avgTps += tps ?? output_tokens / duration;
						});

						const log = logs[0];
						if (!log) {
							logData.value = "无记录";
							return;
						}
						logData.value = [
							totalInput,
							totalCacheRead,
							totalOutput,
							totalReasoning,
							totalCacheWrite,
							log.time,
							log.latency / 1000,
							totalTime,
							totalCost,
							log.currency,
							avgTps / logs.length,
							logs.at(-1).finish_reason
						];
					});
				}} style={"--height:"+(30 + (m.end_index-m.index)*64)+"px"}>
					<i className="ri-information-line"></i>
					<div className="stats-popover">
						{() => {
							const item = unconscious(logData);
							if (typeof item !== 'object') return <div className="stats-row"><div className="stats-row-top">{item || "数据暂缺"}</div></div>;

							let [
								input_tokens, cached_tokens, output_tokens, reasoning_tokens, cache_write_tokens,
								time, latency, duration, cost, currency, tps, finish_reason
							] = item;

							return <div className="stats-row">
								<div className="stats-row-top">
									<span className="tps">
										{tps ? tps.toFixed(2)+" TPS" : finish_reason}
									</span>
									&nbsp;
									<span className="timestamp" title={`开始于: ${formatDate('Y-m-d H:i:s', time)}\n首字延迟: ${latency.toFixed(2)}s`}>
										{duration.toFixed(2)}s
									</span>
								</div>
								<div className="stats-row-bottom">
									{input_tokens ? <span>↑ <b>{input_tokens}{cached_tokens?` (+${cached_tokens})`:null}</b> Tokens</span> : null}
									{output_tokens ? <span title={"缓存写入: " + cache_write_tokens}>↓ <b>{output_tokens}{reasoning_tokens?` (${reasoning_tokens} 思考)`:null}</b> Tokens</span> : null}
									{cost ? (<span>价格: <b>{currency === 'CNY' ? '￥' : '$'}{cost.toFixed(7)}</b></span>) : null}
								</div>
							</div>;
						}}
					</div>
				</div>);
			case "branch":
				return (
					<div className="branch-selector" onClick.delegate{'button'}={({delegateTarget}) => {
						const branchIndex = item.current + parseInt(delegateTarget.dataset.step);
						if (item.callback) item.callback(branchIndex);
						else setBranchIndex(m.key, branchIndex);
					}}>
								<button data-step="-1" className="ri-play-reverse-fill" title="上一版本"
										disabled={item.current === 0}></button>
								<span className="branch-count">{item.current+1} / {item.total}</span>
								<button data-step="1" className="ri-play-fill" title="下一版本"
										disabled={item.current === item.total-1}></button>
							</div>);
		}
	}, chunkKeyFunc.bind(null,m), {
		morphChild: MORPH_CHILD_HANDLER,
		currentKeys: new NestedMap()
	});
}

/**
 * @param {AiChat.Message} message
 * @param {AiChat.ResponseContentPart[]} chunks
 * @param {number} index
 * @param {AiChat.Message[]} messages
 */
function chunkGather(message, chunks, index, messages) {
	const role = message.role;
	const getChunks = MessageRoles[role]?.getChunks;
	if (getChunks) {
		const isPostHook = getChunks(message, chunks, index, isEditing, messages);
		if (!isPostHook) return;
	} else if (!EditableMessageRoles.has(role)) {
		chunks.push({
			type: "error",
			title: "不支持的角色，插件是否加载？",
			error: message
		})
		return;
	}

	let {think, reasoning_details, content, tool_calls, error, finish_reason} = message;

	if (think) {
		const child = { type: "think", think };
		if (reasoning_details) child.reasoning_details = reasoning_details;
		chunks.push(child);
	}

	if (Array.isArray(content)) {
		let images = [];

		for (let i = 0; i < content.length; i++){
			const chunk = content[i];
			if (chunk.type === "image_url") {
				images.push(chunk);
			} else {
				if (images.length) {
					chunks.push({type: "images", images});
					images = [];
				}
				chunks.push({
					...chunk,
					key: i
				});
			}
		}

		if (images.length) chunks.push({type: "images", images});
	} else if (content || isEditing(message)) {
		chunks.push({
			type: "text",
			key: message,
			text: content
		});
	}

	if (tool_calls) {
		for (let j = 0; j < tool_calls.length; j++) {
			const tool = tool_calls[j];
			chunks.push({
				type: "tool_call",
				tool,
				message,
				idx: j
			});
			const response = message.tool_responses?.[j];
			const name = tool.function.name;
			if (response) {
				if (toolScriptRegistry[name]?.renderer && response.time) {
					chunks.push({
						type: "tool",
						tool_name: name,
						idx: index,
						response,
						tool
					});
				}
			}
		}
	}

	if (!error) {
		if (finish_reason === 'interrupt') error = "你中断了生成";
		if (finish_reason === 'length') error = "达到最大输出长度";
	}
	if (error) {
		chunks.push({ type: "error", error, key: message });
	}

	if (getChunks) getChunks(message, chunks, index, isEditing, messages, 1);
}

/**
 * @param {AiChat.AssistantMessage} message
 * @param {AiChat.ResponseContentPart} chunk
 */
function chunkKeyFunc(message, chunk) {
	const {key, type} = chunk;

	const keys = [];

	let kf;
	if ((kf = MessageRoles[key?.role]?.keyFunc)) {
		const kfKeys = kf(chunk, keys);
		if (kfKeys) return kfKeys;
	}

	const add = (el) => {
		if (el) {
			if (Array.isArray(el)) keys.push(...el);
			else keys.push(el);
		}
	};

	add(key);

	switch (type) {
		default: keys.push(type); break;
		case "error": keys.push("error", chunk.error); break;
		// stream markdown renderer would handle this now!
		case "text": keys.push("text"); break;
		case "think": add(chunk.think.title ? [chunk.think.title, chunk.think.content] : chunk.think); break;
		case "tool_call": keys.push(chunk.tool); break;
		case "tool": {
			// 这里到底需要哪些字段，重构的我都忘了
			const {response, time, tool_name, idx} = chunk;
			keys.push(response);
			keys.push(time);

			let kf;
			if ((kf = toolScriptRegistry[tool_name]?.keyFunc)) {
				const has_successor = idx !== messages.length - 1;
				kf(keys, response, has_successor);
				return keys;
			} else {
				keys.push(response.success);
			}
		}
		break;
		case "images": keys.push(chunk.images); break;
		case "html": keys.push(chunk.html); break;
	}

	if (type === "text" || type === "think") {
		if (isEditing(message.key)) keys.push(1);
	}

	//console.log(chunk, " => ", keys);
	return keys;
}
//endregion
//region 悬浮按钮处理
let hoveringElement;
let hoveringMessage;

const regenBtn = <button data-action="regen" title="重新生成" className="ri-loop-right-line ghost" />;
const deleteBtn = <button data-action="del" title="删除" className="ri-delete-bin-line ghost" />;
const undoBtn = <button data-action="undo" title="撤销最后一步" className="ri-arrow-go-back-line ghost" />;
const copyBtn = <button data-action="copy" title="复制" className="ri-file-copy-line ghost" />;
const editBtn = <button data-action="edit" title="编辑" className="ri-edit-2-fill ghost" />;
const saveBtn = <button data-action="edit" title="保存" className="ri-check-line ghost" />;
const insertThinkBtn = <button data-action="think" title="插入思考块" className="ri-ai-generate-text ghost" />;
const insertToolBtn = <button data-action="tool" title="插入工具块" className="ri-tools-line ghost" />;

const orderedButtons = [editBtn, saveBtn, insertThinkBtn, insertToolBtn, copyBtn, undoBtn, regenBtn, deleteBtn];

/**
 * 更新悬浮按钮
 * @param {AiChat.Message} m
 * @param {HTMLSpanElement} container
 */
function updateButtons(m, container) {
	if (hoveringElement && hoveringElement !== container) {
		hoveringElement.className = "";
		hoveringElement.replaceChildren();
	}

	hoveringMessage = m;
	hoveringElement = container;

	if (!container) return;

	const {index, end_index, content, role, key} = m;

	const haveBranches = selectedConversation.bm_leaf;
	const buttons = [];
	const notGenerating = !unconscious(abortCompletion);
	const isEditing_ = isEditing(key);
	const isLast = (end_index ? end_index === messages.length : index === messages.length-1);
	const mayChange = (!isLast || notGenerating) && EditableMessageRoles.has(role) && !key.isOther;
	const isComposite = end_index > index + 1;
	// 不支持编辑组合消息（工具调用）
	if (mayChange && !isComposite) buttons.push(isEditing_ ? saveBtn : editBtn);
	if (!isEditing_) {
		// 有内容才能复制
		if ((!isLast || notGenerating) && (key[MessageCopyHandler] || unconscious(content).find(item => item.text))) buttons.push(copyBtn);
		if (notGenerating) {
			// 最后一条助手消息，而不是最后一条消息，只有助手消息才有end_index
			if (end_index && isLast) {
				if (end_index !== 1) buttons.push(regenBtn);
				if (isComposite) buttons.push(undoBtn);
			} else if (haveBranches) {
				if (role === 'assistant') {
					buttons.push(regenBtn);
				}
			}
		}
		if (mayChange) buttons.push(deleteBtn);
	} else {
		if (m.role === "assistant") {
			if (!key.think) {
				buttons.push(insertThinkBtn);
			}
			if (config.modalities?.includes("tool") || key.tool_responses) {
				buttons.push(insertToolBtn);
			}
		}
	}

	hoveringElement.className = buttons.length ? "buttons" : "";

	let anchorNode = null;
	for (const element of orderedButtons) {
		if (!buttons.includes(element)) {
			element.remove();
			continue;
		}

		if (element.parentElement === container) {
			anchorNode = element;
			continue; // 未变化则跳过
		}

		if (!anchorNode) {
			// 情况1：向上滚动
			container.prepend(element);
		} else {
			// 情况2：向下滚动
			anchorNode.after(element);
		}
		anchorNode = element;
	}
}

const buttonHandler = (e) => {
	const btn = e.target.closest(".btn-line button[data-action]");
	if (!btn) return;

	/**
	 * @type {AiChat.Message & {
	 *     index: number,
	 *     end_index: number,
	 *     key: AiChat.Message
	 * }}
	 */
	let self = e.target.closest(".msg")._identity;

	const message = self.key;
	switch (btn.dataset.action) {
		case "copy": {
			const m = message[MessageCopyHandler]?.() || getTextContent(self);
			if (window.ClipboardItem) {
				copyButtonAnimation([new ClipboardItem({
					'text/html': new Blob([renderMarkdownToString(m)], {type: 'text/html'}),
					'text/plain': new Blob([m], {type: 'text/plain'})
				})], btn);
			} else {
				// FUCK Secure Context
				copyButtonAnimation(m, btn);
			}
		}
		break;
		case "regen": {
			if (selectedConversation.bm_leaf) {
				setLastMessage(messages[self.index-1]);
			} else {
				deleteMessage(self.index, messages.length);
			}
			submitUserChatMessage();
		}
		break;
		case "undo": {
			const end = self.end_index;
			deleteMessage(end - 1, end);
		}
		break;
		case "del": {
			if (!clickTwice(btn)) return;
			const end = self.end_index || (self.index + 1);
			if (selectedConversation.bm_leaf && (end !== messages.length)) {
				SimpleModal({
					title: "删除警告",
					message: "在分支模式下，删除一条消息将导致该消息和它之后的所有消息被永久移除。",
					onConfirm() {
						deleteMessage(self.index, messages.length);
					}
				});
				return;
			}
			deleteMessage(self.index, end);
		}
		break;
		case "think": {
			message.think = {
				title: "手动插入的思考",
				content: "",
				format: "rc"
			};
			$update(updateMessageUI);
		}
		break;
		case "tool": {
			if (!message.tool_calls) {
				message.tool_calls = [];
				message.tool_responses = [];
			}
			message.tool_calls.push({
				id: Math.random().toString(36).slice(2),
				type: "function",
				function: {}
			});
			message.tool_responses.push({});
			$update(updateMessageUI);
		}
		break;
		case "edit": {
			const currentEditing = getEditing(message);
			const isEditingSelf = currentEditing === message;
			if (currentEditing && !isEditingSelf) {
				selectedConversation[IN_EDIT_MODE] = null;

				const currentRef = combinedMessages.find(item => item.key === currentEditing);

				// 退出编辑模式
				currentRef[PINNED] = false;
				vl.setItem(vl.findIndex(currentRef), currentRef);
			}
			const updateSelf = () => {
				if (selectedConversation.bm_leaf) {
					selectedConversation[IN_EDIT_MODE] = isEditingSelf ? null : message;

					self[PINNED] = !isEditingSelf;
					if (isEditingSelf && message.id === -1) delete message.id;
				} else {
					self[PINNED] = message[IN_EDIT_MODE] = !isEditingSelf;
				}

				// 爷不管了，直接更新HTML
				vl.setItem(vl.findIndex(self), self);
				if (!message.content) $update(updateMessageUI);
			};

			if (isEditingSelf) {
				if (message.think && !message.think.content) delete message.think;

				if (message.id === -1) {
					delete message.id;
					// cloned message
					copyBranchAt(message);
				} else {
					$update(messages);
				}
				updateSelf();
			} else {
				// 如果编辑最后一条，并且是用户消息，那么不弹窗
				if (selectedConversation.bm_leaf && (message !== messages.at(-1) || self.role !== "user")) {
					const newBranch = () => {
						const clonedMessages = [...messages];
						const clonedMessage = structuredClone(message);
						clonedMessage.id = -1;
						selectedConversation[IN_EDIT_MODE] = clonedMessages[self.index] = clonedMessage;
						messages.value = clonedMessages;
					};

					if (config.branchEditHistory) {
						SimpleModal({
							title: "选择分支历史编辑模式？",
							message: "确认：从此处创建一个新分支并编辑\n取消：直接修改历史对话\n该弹窗是您在 '设置 > 自定义' 中开启的高级选项",
							onConfirm: newBranch,
							onCancel: updateSelf
						});
					} else {
						newBranch();
					}

					return;
				}
				updateSelf();
			}
		}
		break;
	}
};

/**
 * 删除消息并撤销他们对上下文的修改
 * @param {number} start
 * @param {number} end
 */
function deleteMessage(start, end) {
	const removed = messages.splice(start, end - start);
	const global = unconscious(selectedConversation);
	undoToolCalls(global, removed, 0);
	$update(updateMessageUI);
}

const TIMEOUT = debugSymbol("_btnTimeout");
// 移动端需要点两下
function clickTwice(btn) {
	if (!btn.classList.toggle("danger")) {
		clearTimeout(btn[TIMEOUT]);
		return true;
	}

	btn[TIMEOUT] = setTimeout(() => {
		btn.classList.remove("danger");
	}, 2000);
	return false;
}
//endregion

export const updateMessageUI = $state();
/**
 * @type {VirtualList}
 */
let vl;

function isEditing(message) {
	return selectedConversation.bm_leaf ? (selectedConversation[IN_EDIT_MODE] === message) : (message[IN_EDIT_MODE]);
}
function getEditing(message) {
	return selectedConversation.bm_leaf ? selectedConversation[IN_EDIT_MODE] : message[IN_EDIT_MODE] && message;
}

function getBranchChunk(message, chunks) {
	const [branchIndex, branchCount] = getBranchIndexCount(message);
	if (branchCount > 1) {
		chunks.push({
			type: "branch",
			current: branchIndex,
			total: branchCount
		});
	}
}

const combinedMessages = $computed((oldMessages) => {
	const byIndex = new Map;
	if (oldMessages) {
		for (const oldMessage of oldMessages) {
			byIndex.set(oldMessage.key, oldMessage);
		}
	}

	const out = [];

	const arr = unconscious(messages);
	for (let i = 0; i < arr.length;) {
		let message = arr[i];
		if (message.hidden) { i++; continue; }

		const oldMessage = byIndex.get(message);
		if (oldMessage) oldMessage.index = i;

		/** @type {AiChat.ResponseContentPart[]} */
		const chunks = [];
		/** @type {AiChat.MessageListItem} */
		const ref = oldMessage || {
			key: message,
			index: i,
			role: message.role,
			content: chunks,
		};

		const isAssistantMessage = message.role === "assistant";
		let isReactiveElement = true || isAssistantMessage || MessageRoles[message.role]?.reactive;
		if (typeof isReactiveElement === 'function') isReactiveElement = isReactiveElement(ref);

		if (!oldMessage || isReactiveElement) chunkGather(message, chunks, i, arr);

		i++;
		out.push(ref);

		if (!isReactiveElement) {
			getBranchChunk(message, chunks);
			ref[PINNED] = isEditing(message);
			ref.time = ref.key.time;
			continue;
		}

		/** @type {boolean} */
		let generationEnded;

		if (isAssistantMessage) {
			if (config.combineToolCalls) {
				for (; i < arr.length; i++) {
					if (message.finish_reason !== "tool_calls") break;
					message = arr[i];
					if (message.role !== "assistant") break;
					chunkGather(message, chunks, i, arr);
				}
			}

			ref.model = ref.key.model;
			ref.time = ref.key.time;
			ref.end_index = i;

			generationEnded = message.finish_reason !== '';
			ref[PINNED] = !generationEnded || isEditing(message);
			if (!generationEnded) {
				if (!message.time) chunks.push({ type: "loading" });
				else if (!message.content && !message.think)
					chunks.push({ type: "text", text: "" });
			}
			// show token usage & billing
			else {
				// 手动添加的消息不显示usage
				if (message.finish_reason)
					chunks.push({type: "usage"});
				getBranchChunk(arr[ref.index], chunks);
			}
		} else {
			getBranchChunk(message, chunks);
			ref[PINNED] = isEditing(message);
			ref.time = ref.key.time;
		}

		if (oldMessage) {
			let prevChunks = oldMessage.content;

			if (generationEnded && i === arr.length) {
				// 因为流md渲染已经和常规渲染同构，不需要再次解析
				const at = prevChunks.at(-1);
				if (at?.type === "text") at.text = message.content;
			}

			// 因为用虚拟列表了，不会有多大开销的，大部分都没有渲染，没有监听器
			prevChunks.value = chunks;
		} else {
			ref.content = $state(chunks);
		}
	}

	return out;
}, [messages, updateMessageUI, $computed(() => config.combineToolCalls)]);

$watch([messages, updateMessageUI, abortCompletion], () => {
	if (hoveringElement?.isConnected) updateButtons(hoveringMessage, hoveringElement);
	else {
		hoveringMessage = null;
		hoveringElement = null;
	}
}, false);

/**
 *
 * @param {AiChat.Message} m
 * @return {string}
 */
function roleName(m) {
	if (m.role === "user") return m.name || "你";
	if (m.role === "system") return "系统提示";

	return MessageRoles[m.role]?.name || m.model || "AI";
}

const roleSelection = ["system", "user", "assistant"];

export function MessageList() {
	/**
	 *
	 * @param {AiChat.Message} m - CombinedMessage
	 * @return {JSX.Element}
	 */
	const renderer = (m) => {
		let buttons;
		const {role, time} = m;

		const callback = () => updateButtons(m, buttons);
		const buttonDiv = <div className={"btn-line"}><span ref={buttons}></span></div>;
		const isAI = !selectedConversation.noAI;
		const div = <div onMouseEnter={callback} onTouchStart.passive={callback} className={`msg ${role}`} _identity={m}>
			<div className={"line"}>
				{isEditing(m.key) && isAI && roleSelection.includes(m.role) ? <select onChange={e => {
					const role = m.role = m.key.role = e.target.selectedOptions[0].value;
					m.content = (role==='assistant'?$state:unconscious)(m.content);
					vl.setItem(vl.findIndex(m), m);
					$update(updateMessageUI);
				}}>
					{roleSelection.map(name =>
						<option selected={m.role === name} value={name}>{name}</option>)
					}
				</select> : <b>{roleName(m)}</b>}
				<span className='time'>{formatDate('Y-m-d H:i:s', time??null)}</span>
				<span className='spacer'></span>
			</div>
			{isMobile ? null : buttonDiv}
			<div className="body">{chunkRenderer(m)}</div>
			{!isMobile ? null : buttonDiv}
		</div>;

		if (hoveringMessage === m) updateButtons(m, buttons);
		return div;
	};

	vl = new VirtualList({
		itemHeight: innerHeight,
		overscan: 199,
		keyFunc: (item) => [item.key, item.key.time],
		// 又是tricky code过段时间要重构掉
		isSameKey: (el, b) => {
			const [key, time] = el[ITEM_KEY];
			if (key !== b[0]) return false;
			if (time === b[1]) return true;
			if (key.role === "assistant" && key === messages.at(-1)) {
				morphdom(el.querySelector(".line"), renderer(el._identity).children[0]);
				return true;
			}
			return false;
		},
		renderer
	});

	vl.dom.addEventListener("click", buttonHandler);
	vl.dom.addEventListener("click", copyCodeEventHandler);

	$watch(combinedMessages, () => {
		vl.setItems(combinedMessages.value);
	});

	return new AppendObserver(self => {
		const wrapper = self.closest(".chat");
		vl.attach(wrapper);
		self.replaceWith(vl.dom);

		wrapper.scrollToBottom = () => {
			vl._visible = false;
			requestAnimationFrame(() => {
				vl._visible = true;
				vl.scrollToBottom();
			});
		};
		wrapper.vl = vl;
	});
}
