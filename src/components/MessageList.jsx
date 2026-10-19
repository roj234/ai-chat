import {ThinkBlock} from "./ThinkBlock.jsx";
import {ToolCallCard} from "./ToolCallCard.jsx";
import {
	$computed,
	$derived,
	$foreach,
	$state,
	$unwatch,
	$update,
	$watch,
	AppendObserver,
	debugSymbol,
	hasListener,
	ref,
	unconscious
} from "unconscious";
import {formatDate, formatSize, prettyTime} from "unconscious/common/Utils.js";
import {copyCodeEventHandler, renderMarkdownToElement, renderMarkdownToString} from "../markdown/markdown.js";
import {
	abortCompletion,
	auxKeyboardOnly,
	auxMainlyTouch,
	auxSmallScreen,
	config,
	EditableMessageRoles,
	MessageCopyHandler,
	MessageRoles,
	messages,
	PROGRESS_KIND,
	PROGRESS_VALUE,
	selectedConversation,
	updateMessageUI
} from "../states.js";
import {submitUserChatMessage} from "../api-request.js";
import {
	copyButtonAnimation,
	downloadFile,
	errorBlock,
	getRandomString,
	getTextContent,
	onReuse_Callback,
	prettyError,
	ReuseDelegator,
	showImageZoomView
} from "../utils/utils.js";
import "./MessageList.css";
import "./TimelineDivider.css";
import {getToolName, getToolParameters, toolScriptRegistry, undoToolCalls} from "../toolset.js";
import {getImmediateMessages, markMessageDirty} from "../database.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {cloneMessage, enableBranches, switchBranch} from "../utils/BranchManager.js";
import {ITEM_KEY, PINNED, VirtualList} from "unconscious/common/VirtualList.js";
import {EditWidget} from "./EditWidget.jsx";
import {AudioPlayer} from "./AudioPlayer.jsx";

import SimpleModal from "./SimpleModal.jsx";
import {ToolCallEditor} from "./ToolCallEditor.jsx";
import {StatusPill} from "./StatusPill.jsx";
import {UsageBlock} from "./UsageBlock.jsx";
import {decodeObjects, encodeObjects} from "../utils/serialization.js";
import {openJsonEditor} from "../json_editor/JsonEditDialog.js";
import {inspect} from "unconscious/common/inspect.js";
import {formatDuration} from "/common/pure-utils.js";

const CURRENT_EDITING = debugSymbol("EditingNow");
const isEditing = message => (selectedConversation[CURRENT_EDITING] === message);

const CTC_EXPAND_ALL = debugSymbol("ExpandedSize");
const CTC_BASE_COUNT = 2;

/**
 *
 * @param {File} blob
 * @param {string} className
 * @return {JSX.Element}
 */
const createBlobDisplay = (blob, className) => {
	const deleted = blob.size <= 0;
	return <div className={"text-attachment"+(deleted ? " deleted" : "")}>
		<div className="attach-header">
			<i className={className}></i>
			<span className="ellipsis">{blob.name || "文件"}</span>
			{!deleted && <span className="attach-meta ellipsis">{formatSize(blob.size)}, {prettyTime(blob.lastModified)}上传</span>}
		</div>
		<button className="btn" disabled={deleted}
				onClick={() => downloadFile(blob)}>
			<i className="ri-download-line"></i> 下载
		</button>
	</div>
};

// region AiChat.ResponseContentPart[] 的生成和渲染函数
/**
 *
 * @param {AiChat.AssistantMessage} m
 * @return {AppendObserver}
 */
const chunkRenderer = m => {
	const currentKeys = new NestedMap();
	return $foreach(m.content, (item) => {
		switch (item.type) {
			default: {
				let {error, title} = item;
				if (!error) return errorBlock(item, "不支持渲染");
				if (typeof error !== "string") error = prettyError(error);
				if (title) return errorBlock(error, title);

				const index = error.indexOf('\n');
				return errorBlock(error.slice(index+1), error.substring(0, index));
			}
			case "html":
				let element = item.html;
				if (typeof element === "function") element = element();
				return typeof element === "string" ? <div dangerouslySetInnerHTML={item.html} /> : element;
			case "progress":return <StatusPill {...item} />;
			case "divider": {
				const s1 = $state();
				const node = <div className="timeline-divider">
					<button onClick={() => {
						const message = m.key;
						message[CTC_EXPAND_ALL] ^= 1;
						$update(updateMessageUI);
					}}>
						<span className={"ri-stack-line"}/>
						{s1} <span className="white"></span> 步 · 用时 <span className="white"></span>
					</button>
				</div>;
				(node[onReuse_Callback] = (node, item) => {
					const message = m.key;
					s1.value = message[CTC_EXPAND_ALL] ? "收起" : "展开";
					const arr = node.querySelectorAll('.white');
					arr[1].textContent = formatDuration(item.time/1000);
					arr[0].textContent = item.rounds;
				})(node, item);
				return node;
			}
			case "input_audio": {
				const src = item.input_audio.data;
				if (src.size < 0) return createBlobDisplay(src, "ri-file-music-line");
				return <AudioPlayer src={src} />
			}
			case "text": {
				let text = item.text;
				if (typeof text !== "string") {
					if (!text) return <div className={"md"}><em>没有数据</em></div>;
					return createBlobDisplay(text, "ri-file-text-line");
				}

				ineditable:
				if (isEditing(m.key)) {
					let assistantKey = item.key;
					if (assistantKey) {
						if (Array.isArray(assistantKey)) {
							text = assistantKey[0].content[assistantKey[1]].text;
						} else if (typeof assistantKey.content === 'string') {
							text = assistantKey.content;
						} else {
							break ineditable;
						}
					}

					return <EditWidget value={text} placeholder={"消息正文 content"} onChange={value => {
						if (Array.isArray(assistantKey)) {
							assistantKey[0].content[assistantKey[1]].text = value;
						} else {
							assistantKey.content = value;
						}
					}} />;
				}

				return config.afkState === 2 ? <div className={"md"} style={"white-space:pre-line"}>{text}</div> : renderMarkdownToElement(<div className="md"/>, text);
			}
			case "images":
				return <div className="gallery">{item.images.map(part => {
					const file = part.image_url.url;
					const src = typeof file === "string" ? file : file.toUrl();
					return <img src={src} alt={file.name || '图片'} onClick={() => showImageZoomView(src, file.name)} />;
				})}</div>;
			case "think":
				return <ThinkBlock {...item} edit={isEditing(m.key)}/>;
			case "tool":
				return isEditing(m.key) ? <ToolCallEditor {...item} /> : <ToolCallCard {...item} />;
			case "tool_ui":
				const frozen = item.idx < messages.length - 1;
				try {
					return toolScriptRegistry[item.name].renderer(item.response, frozen, item.tool, messages[item.idx]);
				} catch (e) {
					return errorBlock(e, "工具UI渲染失败");
				}
			case "usage":
				return UsageBlock(m);
			case "branch":
				return (
					<div className="branch-selector" onClick.delegate{'button'}={({delegateTarget}) => {
						const branchIndex = item.current + parseInt(delegateTarget.dataset.step);
						if (item.callback) item.callback(branchIndex);
						else {
							const conv = unconscious(selectedConversation);
							const bm = getImmediateMessages(conv);
							const old = [...bm];
							bm.switchBranch(bm.parentOf(m.key), branchIndex);
							switchBranch(old, bm, conv);
							$update(messages);
						}
					}}>
						<button data-step="-1" className="ri-play-reverse-fill" title="上一版本" disabled={() => item.current === 0 || unconscious(abortCompletion)}></button>
						<span className="branch-count">{item.current+1} / {item.total}</span>
						<button data-step="1" className="ri-play-fill" title="下一版本" disabled={() => item.current === item.total - 1 || unconscious(abortCompletion)}></button>
					</div>);
		}
	}, chunkKeyFunc.bind(currentKeys,m), {
		onReuse: ReuseDelegator,
		currentKeys
	});
};

/**
 *
 * @param {string} content
 * @param {AiChat.ResponseContentPart[]} chunks
 * @param {AiChat.Message} message
 */
const defaultRenderContent = (message, chunks, content) => {
	if (Array.isArray(content)) {
		let images = [];

		for (let i = 0; i < content.length; i++) {
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
					key: [message, i]
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
};

/**
 * @param {AiChat.Message} message
 * @param {AiChat.ResponseContentPart[]} chunks
 * @param {number} index
 * @param {AiChat.Message[]} messages
 */
const chunkGather = (message, chunks, index, messages) => {
	let {think, content, tool_calls, error, finish_reason} = message;

	if (think) chunks.push({ type: "think", think, message });

	const role = message.role;
	const renderContent = MessageRoles[role]?.renderContent;
	if (renderContent) {
		renderContent(message, chunks, index, isEditing, messages, defaultRenderContent);
	} else {
		if (typeof content !== 'string' && !EditableMessageRoles.has(role)) {
			chunks.push({
				type: "error",
				title: "未定义的消息类型，无法渲染内容。",
				error: content
			});
		} else {
			defaultRenderContent(message, chunks, content);
		}
	}

	if (tool_calls) {
		for (let j = 0; j < tool_calls.length; j++) {
			const tool = tool_calls[j];
			chunks.push({
				type: "tool",
				tool,
				message,
				idx: j
			});
			const response = message.tool_responses[j];
			const name = getToolName(response, tool);
			const fn = toolScriptRegistry[name];
			if (fn?.renderer && response && (null != fn.interactive || response.time) && getToolParameters(response, tool, true)) {
				chunks.push({
					type: "tool_ui",
					name,
					idx: index,
					response,
					tool
				});
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
};

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
		case "progress": keys.push(chunk.data); break;
		case "error": keys.push(type, chunk.error); break;
		case "text": keys.push(chunk.text); break;
		case "think": add(chunk.think.title ? [chunk.think.title, chunk.think.content] : chunk.think); break;
		case "tool": keys.push(chunk.tool); break;
		case "tool_ui": {
			// 这里到底需要哪些字段，重构的我都忘了
			const {response, time, name, idx} = chunk;
			keys.push(response);
			keys.push(time);

			let kf;
			if ((kf = toolScriptRegistry[name]?.keyFunc)) {
				const has_successor = idx !== messages.length - 1;
				kf(keys, response, has_successor, messages[idx]);
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

	// really tricky, right?
	/** @type{string} */
	const swapKey = chunk.swap;
	if (swapKey && swapKey !== keys.at(-1)) {
		const oldKey = keys.slice(0, -1);
		oldKey.push(swapKey);

		const node = this.get(oldKey);
		if (node) {
			if (type !== 'think' || node.open) {
				this.delete(oldKey);
				this.set(keys, node);
			}
		}

		delete chunk.swap;
	}

	//console.log(chunk, " => ", keys);
	return keys;
}
//endregion
//region 悬浮按钮处理

const regenBtn = <button data-action="regen" title="重新生成" className="ri-loop-right-line ghost" />;
const deleteBtn = <button data-action="del" title="删除" className="ri-delete-bin-line ghost" />;
const undoBtn = <button data-action="undo" title="撤销最后一步" className="ri-arrow-go-back-line ghost" />;
const copyBtn = <button data-action="copy" title="复制" className="ri-file-copy-line ghost" />;
const editBtn = <button data-action="edit" title="编辑" className="ri-edit-2-fill ghost" />;
const branchBtn = <button data-action="branch" title="在此处分叉" className="ri-git-fork-line ghost" />
const saveBtn = <button data-action="save" title="保存" className="ri-check-line ghost" />;
const insertThinkBtn = <button data-action="think" title="插入思考块" className="ri-ai-generate-text ghost" />;
const insertToolBtn = <button data-action="tool" title="插入工具块" className="ri-tools-line ghost" />;

const buttonOrder = [editBtn, saveBtn, branchBtn, insertThinkBtn, insertToolBtn, undoBtn, regenBtn, copyBtn, deleteBtn];

/**
 * 更新悬浮按钮
 * @param {AiChat.MessageListItem} m
 * @param {HTMLSpanElement} container
 */
function updateButtons(m, container) {
	const {index, end_index, content, key} = m;
	const role = key.role;

	const buttons = [];
	const notGenerating = !unconscious(abortCompletion);
	const isLast = (end_index ? end_index === messages.length : index === messages.length-1);
	const mayChange = (!selectedConversation[CURRENT_EDITING]) && (!isLast || notGenerating) && EditableMessageRoles.has(role);
	const isComposite = end_index > index + 1;
	// 不支持编辑组合消息（工具调用）
	const mayModification = notGenerating && mayChange;
	if (mayModification) {
		buttons.push(editBtn);
		if (role !== 'assistant' && !isLast)
			buttons.push(branchBtn);
	}
	if (!isEditing(key)) {
		// 有内容才能复制
		if ((!isLast || notGenerating) && (key[MessageCopyHandler] || unconscious(content).find(item => item.text))) buttons.push(copyBtn);
		if (notGenerating && mayChange) {
			// 最后一条助手消息，而不是最后一条消息，只有助手消息才有end_index
			if (end_index) {
				if (isLast && isComposite) buttons.push(undoBtn);
				else if (end_index !== 1) buttons.push(regenBtn);
			}
			buttons.push(deleteBtn);
		}
	} else {
		buttons.push(saveBtn);
		if (role === "assistant") {
			if (!key.think) {
				buttons.push(insertThinkBtn);
			}
			if (config.modalities.includes("tool") || key.tool_responses) {
				buttons.push(insertToolBtn);
			}
		}
	}

	const children = [...container.children];
	let j = 0;

	outer:
	for (let i = 0; i < buttonOrder.length; i++){
		const element = buttonOrder[i];
		if (!buttons.includes(element)) continue;

		while (j < children.length) {
			const el = children[j++];
			if (element.dataset.action === el.dataset.action) continue outer;
			el.remove();
		}

		container.append(element.cloneNode(true));
	}

	while (j < children.length) children[j++].remove();

	container.style.display = buttons.length ? '' : 'none';
}

const BRANCH_TEMP_ID = -3;

/**
 * @param {import("unconscious").Reactive<AiChat.Conversation>} selectedConversation
 * @param {import("unconscious").Reactive<AiChat.Message[]>} messages
 * @param {Event} e
 */
const buttonOnLeft = (selectedConversation, messages, e) => {
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
	const vl = e.target.closest("._vl")._vl;

	const conv = unconscious(selectedConversation);
	const message = messages[self.end_index - 1] ?? self.key;
	let msgs = unconscious(messages);

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
			if (!selectedConversation.bm_leaf) {
				messages.value = msgs = enableBranches(selectedConversation);
			}

			/** @type {AiChat.BranchManager} */
			const old = [...msgs];
			msgs.setLeaf(msgs[self.index-1]);
			switchBranch(old, msgs, conv);
			submitUserChatMessage();
			$update(messages);
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
			if (selectedConversation.bm_leaf && end !== msgs.length) {
				SimpleModal({
					title: "警告",
					message: "您正在删除包含分支点的对话，继续将删除它和后续所有对话。",
					onConfirm() {
						deleteMessage(self.index, msgs.length);
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
				id: "tc_"+getRandomString(8),
				type: "function",
				function: {}
			});
			message.tool_responses.push({});
			$update(updateMessageUI);
		}
		break;
		case "branch": {
			if (!selectedConversation.bm_leaf) {
				messages.value = msgs = enableBranches(selectedConversation);
			}

			const clonedMessages = [...msgs];
			const clonedMessage = cloneMessage(message);
			clonedMessage.id = BRANCH_TEMP_ID;
			clonedMessage[PINNED] = true;
			selectedConversation[CURRENT_EDITING] = clonedMessages[self.index] = clonedMessage;
			messages.value = clonedMessages;
		}
		break;
		case "edit": {
			delete message.error;
			const fr = message.finish_reason;
			if (fr === 'error') message.finish_reason = 'stop';

			selectedConversation[CURRENT_EDITING] = message;
			self[PINNED] = true;

			// 爷不管了，直接更新HTML
			vl.setItem(vl.findIndex(self), self);
			if (!message.content || self.end_index) $update(updateMessageUI);
		}
		break;
		case "save": {
			if (message.think && !message.think.duration && !message.think.content) delete message.think;

			markMessageDirty(message);
			selectedConversation[CURRENT_EDITING] = null;
			self[PINNED] = false;
			vl.setItem(vl.findIndex(self), self);

			if (message.id === BRANCH_TEMP_ID) {
				messages.value = msgs = getImmediateMessages(unconscious(selectedConversation));
				delete message.id;
				// cloned message
				const old = [...msgs];
				msgs.branchAt(msgs.parentOf(message), message);
				switchBranch(old, msgs, conv);
			} else {
				$update(messages);
			}
		}
		break;
	}
};
/**
 * @param {import("unconscious").Reactive<AiChat.Conversation>} selectedConversation
 * @param {import("unconscious").Reactive<AiChat.Message[]>} messages
 * @param {Event} e
 */
const buttonOnRight = async (selectedConversation, messages, e) => {
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

	const message = messages[self.end_index - 1] ?? self.key;

	switch (btn.dataset.action) {
		case "edit": {
			if (message.id < 0) return;

			e.preventDefault();
			let jsonText, update, onclose;
			let updatePromise = async () => {
				const mapping = new Map;
				await encodeObjects(message, mapping);
				jsonText = inspect(message, mapping.size ? (_, value) => mapping.get(value) ?? value : null);
				update?.();
			};
			//conv[CURRENT_EDITING] = message;

			let skipNext;
			[update, onclose] = openJsonEditor("message#"+message.id,
				() => jsonText,
				async (obj) => {
					const changedMessage = await decodeObjects(obj);

					const id = message.id;

					Object.keys(message).forEach(item => { delete message[item]; });
					Object.assign(message, changedMessage);

					message.id = id;
					markMessageDirty(message);
					$update(messages);
					skipNext = true;
				}
			);
			const syncToEditor = () => {
				if (skipNext) skipNext = false;
				else updatePromise();
			};

			$watch(messages, syncToEditor);
			onclose(() => {
				$unwatch(messages, syncToEditor);
				//conv[CURRENT_EDITING] = null;
			})
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
}

const TIMEOUT = debugSymbol("_btnTimeout");
// 点两下
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

function getBranchChunk(messages, message, chunks) {
	const info = messages.getBranchInfo?.(message);
	if (info && message.id !== BRANCH_TEMP_ID) {
		chunks.push({
			type: "branch",
			current: info[0],
			total: info[1]
		});
	}
}

const TRAILER_TYPES = new Set(['branch', 'usage', 'progress']);

class MessageListItem {
	#list;
	/** @type {import("unconscious").Reactive<AiChat.ResponseContentPart[]>} */
	#content = $state([]);
	#dirty = true;
	/** @type {number} */
	index;
	/** @type {number} */
	//end_index;

	/**
	 * @param {AiChat.Message} message
	 */
	constructor(message) {
		this.key = message;
	}

	get content() {
		if (this.#dirty) {
			this.#updateContent();
		}
		return this.#content;
	}

	//get messages() {return this.#list;}

	/**
	 *
	 * @param {AiChat.Message[]} messages
	 * @param {number} startIndex
	 * @param {number} endIndex
	 */
	markDirty(messages, startIndex, endIndex) {
		this.#list = messages;
		this.index = startIndex;
		//this.end_index = endIndex;

		if (hasListener(this.#content)) {
			this.#updateContent();
		} else {
			this.#dirty = true;
		}
	}

	#updateContent() {
		const messages = this.#list;
		const ref = this;
		let message = ref.key;
		let i = ref.index;
		let lastGroup = 0;

		let chunks = [];

		/** @type {boolean} */
		let generationEnded;

		if (message.role === "assistant") {
			i++;

			if (config.combineToolCalls) {
				let j = i;
				const firstMessage = message;

				const obj = {type: "divider",};
				chunks.push(obj);

				const expanded = firstMessage[CTC_EXPAND_ALL];

				for (;;) {
					lastGroup = chunks.length;

					if (i === messages.length || !message.tool_calls || isEditing(messages[i]) || messages[i].role !== "assistant") {
						chunkGather(message, chunks, i, messages);
						break;
					}

					if (expanded) chunkGather(message, chunks, i, messages);
					else {
						let {tool_calls} = message;

						for (let j = 0; j < tool_calls.length; j++) {
							const tool = tool_calls[j];
							const response = message.tool_responses[j];
							const name = getToolName(response, tool);
							const fn = toolScriptRegistry[name];
							const artifact = fn?.artifact;
							if (!artifact) continue;

							if (artifact.includes('i')) chunks.push({
								type: "tool",
								tool,
								message,
								idx: j
							});

							if (artifact.includes('o') && fn.renderer && response && (null != fn.interactive || response.time) && getToolParameters(response, tool, true)) {
								chunks.push({
									type: "tool_ui",
									name,
									idx: i,
									response,
									tool
								});
							}
						}
					}

					message = messages[i++];
				}

				if (i === j) chunks.shift();
				else {
					obj.rounds = i - j + 1;
					obj.time = (message.time??Date.now()) - firstMessage.time;
				}
			}

			ref.model = message.model;
			ref.end_index = i;

			generationEnded = message.finish_reason !== '';
			ref[PINNED] = !generationEnded || isEditing(message);
			if (!generationEnded) chunks.push({ type: "progress", kind: message[PROGRESS_KIND], data: message[PROGRESS_VALUE] });
			// show token usage & billing
			else {
				getBranchChunk(messages, messages[ref.index], chunks);
				// 手动添加的消息不显示usage
				if (message.finish_reason) chunks.push({type: "usage"});
			}
		} else {
			chunkGather(message, chunks, i, messages);
			getBranchChunk(messages, message, chunks);
			// 自定义消息角色
			if (message.finish_reason) chunks.push({type: "usage"});

			ref[PINNED] = isEditing(message);
		}

		let prevChunks = this.#content;

		// 如果markdown已经渲染好了，那么跳过本次key变化
		// 隐式条件：最后一条不是usage代表上次更新时还在生成
		if (i === messages.length) {
			const lastType = prevChunks.at(-1)?.type;
			if (lastType && lastType !== 'usage') {
				let j = prevChunks.length - 1;
				if (TRAILER_TYPES.has(prevChunks[j].type)) j--;

				let k = chunks.length - 1;
				if (TRAILER_TYPES.has(chunks[k].type)) k--;

				let prev = prevChunks[j], curr = chunks[k];
				if (prev && curr) {
					do {
						const type = curr.type;
						if (type === prev.type) {
							if (type !== 'tool') {
								curr.swap = prev[type];
							}
							break;
						}

						curr = chunks[--k];
					} while (k >= lastGroup);
				}
			}
		}
		prevChunks.value = chunks;

		this.#dirty = false;
	}
}

/**
 *
 * @param {AiChat.MessageListItem} m
 * @return {string}
 */
function roleName(m) {
	const msg = m.key;
	const role = msg.role;
	if (role === "user") return msg.label || "你";
	if (role === "system") return "系统";
	if (role === "fold") return "上下文摘要";
	return MessageRoles[role]?.name || msg.model || "AI";
}

const roleSelection = ["system", "user", "assistant"];

/**
 *
 * @param {import("unconscious").Reactive<AiChat.Message[]>} messages
 * @return {AppendObserver}
 * @constructor
 */
export function MessageList({messages}) {
	let hoverElement;

	function findButtonContainer(node) {
		for (let child of node.children) {
			if (child.matches(".btn-line")) {
				return child.children[0];
			}
		}
	}

	$watch([messages, updateMessageUI, abortCompletion], () => {
		if (auxMainlyTouch || auxKeyboardOnly) {
			for (let node of vl.dom.children) {
				updateButtons(node._identity, findButtonContainer(node));
			}
		} else {
			if (!hoverElement?.isConnected) {
				hoverElement = null;
				return;
			}
			updateButtons(hoverElement._identity, findButtonContainer(hoverElement));
		}
	}, false);

	function renderRole(item, allowEditRole) {
		const msg = item.key;
		return <div className={"role"}>
			{allowEditRole && isEditing(msg) && roleSelection.includes(msg.role) ? <select onChange={e => {
				const role = msg.role = e.target.selectedOptions[0].value;
				const isAssistant = role === 'assistant';
				if (!isAssistant) {
					delete msg.think;
					delete msg.tool_calls;
					delete msg.tool_responses;
				}
				vl.setItem(vl.findIndex(item), item);
				$update(updateMessageUI);
			}}>
				{roleSelection.map(name => <option selected={msg.role === name} value={name}>{name}</option>)}
			</select> : <b className={"stroke"}>{roleName(item)}</b>}
			<span className='time stroke'>{formatDate('Y-m-d H:i:s', msg.time ?? null)}</span>
			<span className='spacer'></span>
		</div>;
	}

	/**
	 * @param {AiChat.MessageListItem} item
	 * @return {JSX.Element}
	 */
	const renderBlock = (item) => {
		let buttons = ref();
		const msg = item.key;

		const buttonDiv = <div className="btn-line"><span className="buttons" style="display:none" ref={buttons}></span></div>;
		const isNormalConversation = !selectedConversation.noAI;
		const div = <div onMouseEnter={() => {
			if (hoverElement) {
				findButtonContainer(hoverElement).style.display = "none";
			}
			hoverElement = div;
			updateButtons(item, buttons);
		}} className={`msg ${msg.role}`} _identity={item}>
			{renderRole(item, isNormalConversation)}
			{auxSmallScreen ? null : buttonDiv}
			<div className="body">{chunkRenderer(item)}</div>
			{!auxSmallScreen ? null : buttonDiv}
		</div>;

		if ((auxKeyboardOnly|auxMainlyTouch) || hoverElement?._identity === item)
			updateButtons(item, buttons);
		return div;
	};

	const vl = new VirtualList({
		itemHeight: 1000,
		overscan: 500,
		keyFunc: (item) => [item.key, item.key.time],
		reuseHook(node, newKey, item) {
			const oldKey = node[ITEM_KEY];
			const msg = item.key;

			if (oldKey[0] !== msg) return false;
			if (oldKey[1] === msg.time) return true;
			if (msg.role === "assistant" && msg === messages.at(-1)) {
				node.firstElementChild.replaceWith(renderRole(item));
				return true;
			}
			return false;
		},
		renderer: renderBlock
	});

	vl.dom.addEventListener("click", buttonOnLeft.bind(null, selectedConversation, messages));
	vl.dom.addEventListener("contextmenu", buttonOnRight.bind(null, selectedConversation, messages));
	vl.dom.addEventListener("click", copyCodeEventHandler);

	const blocks = $computed((oldBlocks) => {
		const out = [];

		let pos = 0;
		const lim = oldBlocks?.length ?? 0;

		const arr = unconscious(messages);
		for (let i = 0; i < arr.length;) {
			const start = i;

			let message = arr[i++];
			if (message.hidden) continue;

			/** @type {MessageListItem} */
			let item;
			while (pos < lim && oldBlocks[pos].key !== message) pos++;
			item = pos < lim ? oldBlocks[pos++] : new MessageListItem(message);

			if (config.combineToolCalls) {
				for (; i < arr.length; i++) {
					if (!message.tool_calls || isEditing(arr[i]) || arr[i].role !== "assistant") break;
					message = arr[i];
				}
			}

			item.markDirty(arr, start, i);
			out.push(item);
		}

		vl.itemHeight = out.length > 10000 ? 17800000 / out.length : innerHeight;
		return out;
	}, [
		messages, updateMessageUI,
		$derived(config.combineToolCalls),
	]);
	$watch(blocks, () => {vl.setItems(unconscious(blocks));});

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
