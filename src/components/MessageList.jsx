import {ThinkBlock} from "./ThinkBlock.jsx";
import {ToolCallCard} from "./ToolCallCard.jsx";
import {$computed, $foreach, $state, $update, $watch, AppendObserver, debugSymbol, unconscious} from "unconscious";
import {formatDate} from "unconscious/ext/Utils.js";
import {copyCodeEventHandler, renderMarkdownToElement, renderMarkdownToString} from "../markdown/markdown.js";
import {abortCompletion, isMobile, MessageRoles, messages, selectedConversation} from "../states.js";
import {sendUserChatMessage} from "../api-request.js";
import {
	copyButtonAnimation,
	errorBlock,
	getTextContent,
	IN_EDIT_MODE,
	loadingBlock,
	MORPH_CHILD_HANDLER,
	prettyError
} from "../utils/utils.js";
import "./MessageList.css";
import {toolScriptRegistry} from "../skills.js";
import {getBillingLog} from "../database.js";
import {MultiKeyMap} from "../utils/MultiKeyMap.js";
import {getBranchIndexCount, setBranchIndex} from "../utils/BranchManager.js";
import {ITEM_KEY, PINNED, VirtualList} from "unconscious/ext/VirtualList.js";
import {EditWidget} from "./EditWidget.jsx";
import {AudioPlayer} from "./AudioPlayer.jsx";

import "./MyLoading.jsx";
import morphdom from "morphdom";

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
				return errorBlock(error.substring(index+1), error.substring(0, index));
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
				if (m.key[IN_EDIT_MODE]) {
					return <EditWidget value={text} onChange={value => {
						item.text = value;
						const message = m.key;
						if (!Array.isArray(message.content)) {
							message.content = value;
						}
					}}></EditWidget>;
				} else {
					const container = <div className="content" />;
					renderMarkdownToElement(container, text);
					return container;
				}
			}
			case "images":
				return <div className="gallery">{item.images.map(part => {
					const url = part.image_url?.url;
					return url && <img src={typeof url === "string" ? url : url.toUrl()}/>;
				})}</div>;
			case "think":
				return <ThinkBlock message={item} edit={m.key[IN_EDIT_MODE]}/>;
			case "tool_call":
				return <ToolCallCard {...item} />;
			case "tool":
				try {
					let has_successor = item.idx !== messages.length - 1;
					return toolScriptRegistry[item.tool_name].renderer(item.response, has_successor);
				} catch (e) {
					console.error(e);
					return errorBlock(e, "工具UI渲染失败");
				}
			case "usage":
				const logs = $state([]);

				return (<div className="stats" onMouseEnter.once={() => {
					Promise.all(messages.slice(m.index, m.end_index).map(m => getBillingLog(m.id))).then((billingLogs) => {
						logs.value = billingLogs;
					});
				}} style={"--height:"+(30 + (m.end_index-m.index)*64)+"px"}>
					<i className="ri-information-line"></i>
					<div className="stats-popover">
						{$foreach(logs, item => {
							if (!item) return <div className="stats-row"><div className="stats-row-top">Token统计暂缺</div></div>;

							let {
								input_tokens, cached_tokens = 0, output_tokens, reasoning_tokens = 0, cache_write_tokens = 0,
								time, ttft, cost, currency, latency, tps, finish_reason
							} = item;
							latency /= 1000;
							ttft /= 1000;
							if (!tps) tps = output_tokens / (latency - ttft);

							return <div className="stats-row">
								<div className="stats-row-top">
									<span className="tps">
										{tps ? tps.toFixed(2)+" TPS" : finish_reason}
									</span>
									&nbsp;
									<span className="timestamp" title={`开始于: ${formatDate('Y-m-d H:i:s', time)}\nTTFT: ${ttft.toFixed(2)}s`}>
										{latency.toFixed(2)}s
									</span>
								</div>
								<div className="stats-row-bottom">
									{input_tokens ? <span title={"缓存读取: " + cached_tokens + "\n缓存写入: " + cache_write_tokens}>输入: <b>{input_tokens}</b> Tokens</span> : null}
									{output_tokens ? <span title={"思考: " + reasoning_tokens}>输出: <b>{output_tokens}</b> Tokens</span> : null}
									{cost ? (<span>价格: <b>{cost}</b> {currency}</span>) : null}
								</div>
							</div>;
						})}
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
		currentKeys: new MultiKeyMap()
	});
}

/**
 * @param {AiChat.AssistantMessage} message
 * @param {AiChat.ResponseContentPart[]} chunks
 * @param {number} message_index
 */
function chunkGather(message, chunks, message_index) {
	const role = message.role;
	const customHandler = MessageRoles[role];
	if (customHandler) {
		customHandler.getChunks(message, chunks, message_index);
		return;
	}

	if (!editableRoles.has(role)) {
		chunks.push({
			type: "error",
			title: "未知的消息角色，插件是否加载？",
			error: message
		})
		return;
	}

	let {think, reasoning_details, content, tool_calls, error} = message;

	if (think) {
		const child = { type: "think", think };
		if (reasoning_details) child.reasoning_details = reasoning_details;
		chunks.push(child);
	}

	if (Array.isArray(content)) {
		let images = [];

		for (const chunk of content) {
			if (chunk.type === "image_url") {
				images.push(chunk);
			} else {
				if (images.length) {
					chunks.push({type: "images", images});
					images = [];
				}
				chunks.push(chunk);
			}
		}

		if (images.length) chunks.push({type: "images", images});
	} else if (content) {
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
				if (toolScriptRegistry[name]?.renderer) {
					chunks.push({
						type: "tool",
						tool_name: name,
						idx: message_index,
						response
					});
				}
			}
		}
	}

	if (!error && message.finish_reason === "interrupt") {
		error = "你中断了生成";
	}
	if (error) {
		chunks.push({ type: "error", error, key: message });
	}
}

/**
 * @param {AiChat.AssistantMessage} message
 * @param {AiChat.ResponseContentPart} chunk
 */
function chunkKeyFunc(message, chunk) {
	const {key, type} = chunk;

	let kf;
	if ((kf = MessageRoles[key?.role]?.keyFunc)) {
		const kfKeys = kf(chunk);
		if (kfKeys) return kfKeys;
	}

	const keys = [];
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
			keys.push(chunk.response);
			keys.push(chunk.time);

			let kf;
			if ((kf = toolScriptRegistry[chunk.tool_name]?.keyFunc)) {
				const has_successor = chunk.idx !== messages.length - 1;
				kf(keys, chunk.response, has_successor);
				return keys;
			}
		}
		break;
		case "images": keys.push(chunk.images); break;
		case "html": keys.push(chunk.html); break;
	}

	if (type === "text" || type === "think") {
		if (message.key[IN_EDIT_MODE]) keys.push(1);
	}

	//console.log(chunk, " => ", keys);
	return keys;
}
//endregion
//region 悬浮按钮处理
const EDITABLE_ROLES = ["system", "user", "assistant"];
const editableRoles = new Set(EDITABLE_ROLES);

let hoveringElement;
let hoveringMessage;

const regenBtn = <button data-action="regen" title="重新生成" className="ri-loop-right-line ghost"></button>;
const deleteBtn = <button data-action="del" title="删除" className="ri-delete-bin-line ghost"></button>;
const undoBtn = <button data-action="undo" title="步退" className="ri-arrow-go-back-line ghost"></button>;
const copyBtn = <button data-action="copy" title="复制内容" className="ri-file-copy-line ghost"></button>;
const editBtn = <button data-action="edit" title="编辑" className="ri-pencil-line ghost"></button>;
const saveBtn = <button data-action="edit" title="保存" className="ri-check-line ghost"></button>;
const insertThinkBtn = <button data-action="think" title="插入思考块" className="ri-ai-generate-text ghost"></button>;

/**
 * 更新悬浮按钮
 * @param {AiChat.Message} m
 * @param {HTMLSpanElement} container
 */
function updateButtons(m, container) {
	if (hoveringElement && hoveringElement !== container) {
		hoveringElement.replaceChildren();
	}

	hoveringMessage = m;
	hoveringElement = container;

	if (!container) return;

	const {index, end_index, content, role} = m;

	const buttons = new Set();
	const notGenerating = abortCompletion.value == null;
	const isEditing = m.key[IN_EDIT_MODE];
	const isNotLast = (end_index ? end_index !== messages.length : index !== messages.length-1);
	const mayChange = (isNotLast || notGenerating) && editableRoles.has(role);
	const isComposite = end_index > index + 1;
	// 不支持编辑组合消息（工具调用）
	if (mayChange && !isComposite) buttons.add(isEditing ? saveBtn : editBtn);
	if (!isEditing) {
		// 有内容才能复制
		if ((isNotLast || notGenerating) && unconscious(content).find(item => item.text)) buttons.add(copyBtn);
		if (end_index === messages.length && notGenerating) {
			// TODO 之前也能regen，要加分叉功能
			if (end_index !== 1) buttons.add(regenBtn);
			if (isComposite) buttons.add(undoBtn);
		}
		if (mayChange) buttons.add(deleteBtn);
	} else {
		if (m.role === "assistant" && !m.key.think) {
			buttons.add(insertThinkBtn);
		}
	}

	for (let child of container.children) {
		if (!buttons.has(child)) child.remove();
	}

	let anchorNode = null;
	for (const element of buttons) {
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
	const btn = e.target.closest(".line button[data-action]");
	if (!btn) return;

	/**
	 * @type {AiChat.Message & {
	 *     index: number,
	 *     end_index: number,
	 *     key: AiChat.Message
	 * }}
	 */
	let self = e.target.closest(".msg")._identity;

	switch (btn.dataset.action) {
		case "copy": {
			const m = getTextContent(self);
			if (window.ClipboardItem) {
				copyButtonAnimation([new ClipboardItem({
					'text/html': new Blob([renderMarkdownToString(m)], {type: 'text/html'}),
					'text/plain': new Blob([m], {type: 'text/plain'})
				})], btn);
			} else {
				// FUCK HTTPS
				copyButtonAnimation(m, btn);
			}
		}
		break;
		case "regen": {
			deleteMessage(messages.length-1, messages.length);
			sendUserChatMessage();
		}
		break;
		case "undo": {
			if (isMobile && !clickTwice(btn)) return;
			const end = self.end_index;
			deleteMessage(end - 1, end);
		}
		break;
		case "del": {
			if (isMobile && !clickTwice(btn)) return;
			deleteMessage(self.index, self.end_index || (self.index + 1));
		}
		break;
		case "think": {
			self.key.think = {
				title: "手动插入的思考",
				content: "a",
				format: "rc"
			};
			$update(updateMessageUI);
		}
		break;
		case "edit": {
			const inEdit = self.key[IN_EDIT_MODE];
			self.key[IN_EDIT_MODE] = !inEdit;
			if (inEdit) {
				if (self.key.think && !self.key.think.content) {
					delete self.key.think;
				}
				$update(messages);
			}

			// 爷不管了，直接更新HTML
			vl.setItem(vl.findIndex(self), self);
		}
	}
};

/**
 * 删除消息并撤销他们对上下文的修改
 * @param {number} start
 * @param {number} end
 */
function deleteMessage(start, end) {
	const deleteCount = end - start;
	const removed = messages.splice(start, deleteCount);
	const globalStorage = selectedConversation.value;
	for (let i = removed.length - 1; i >= 0; i--){
		const {tool_responses} = removed[i];
		if (tool_responses) {
			for (let j = tool_responses.length - 1; j >= 0; j--){
				let toolResponse = tool_responses[j];
				try {
					toolScriptRegistry[toolResponse.tool_name].removed?.(toolResponse, globalStorage);
				} catch (e) {
					console.error(e);
				}
			}
		}
	}

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

const combinedMessages = $computed((oldMessages) => {
	const byIndex = new Map;
	if (oldMessages) {
		for (const oldMessage of oldMessages) {
			byIndex.set(oldMessage.key, oldMessage);
		}
	}

	const out = [];

	for (let i = 0; i < messages.length;) {
		let message = messages.value[i];
		if (message.hidden) { i++; continue; }

		const oldMessage = byIndex.get(message);
		if (oldMessage) oldMessage.index = i;

		/**
		 * @type {AiChat.ResponseContentPart[]}
		 */
		const chunks = [];

		const ref = oldMessage || {
			key: message,
			index: i,
			role: message.role,
			content: chunks,
		};

		const isAssistantMessage = message.role === "assistant";
		let isReactiveElement = isAssistantMessage || MessageRoles[message.role]?.reactive;
		if (typeof isReactiveElement === 'function') isReactiveElement = isReactiveElement(ref);

		if (!oldMessage || isReactiveElement) chunkGather(message, chunks, i);

		i++;
		out.push(ref);

		if (!isReactiveElement) {
			ref.time = ref.key.time;
			continue;
		}

		/** @type {boolean} */
		let generationEnded;

		if (isAssistantMessage) {
			for (; i < messages.length; i++) {
				if (message.finish_reason !== "tool_calls") break;
				message = messages.value[i];
				if (message.role !== "assistant") break;
				chunkGather(message, chunks, i);
			}

			ref.model = ref.key.model;
			ref.time = ref.key.time;
			ref.end_index = i;

			generationEnded = message.finish_reason;
			ref[PINNED] = !generationEnded || message[IN_EDIT_MODE];
			if (!generationEnded) {
				if (!message.time) chunks.push({ type: "loading" });
			}
			// show token usage & billing
			else {
				chunks.push({type: "usage"});

				const [branchIndex, branchCount] = getBranchIndexCount(message);
				if (branchCount > 1) {
					chunks.push({
						type: "branch",
						current: branchIndex,
						total: branchCount
					});
				}
			}
		}

		if (oldMessage) {
			let prevChunks = oldMessage.content;

			if (generationEnded) {
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
}, [messages, updateMessageUI]);

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
	if (m.role === "user") return "你";
	if (m.role === "system") return "系统提示";

	const customHandler = MessageRoles[m.role];
	if (customHandler) return customHandler.name;

	return m.model || "AI";
}

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
		const div = <div onMouseEnter={callback} onTouchStart.passive={callback} onMouseLeave={() => updateButtons()} className={`msg`} _identity={m}>
			<div className={"line"+(isMobile?"":" sticky")}>
				{m.key[IN_EDIT_MODE] ? <select onChange={e => {
					m.role = m.key.role = e.target.selectedOptions[0].value;
				}}>
					{["system", "user", "assistant"].map(name =>
						<option selected={m.role === name} value={name}>{name}</option>)
					}
				</select> : <b>{roleName(m)}</b>}
				<span className='time'>{formatDate('Y-m-d H:i:s', time || 0)}</span>
				<span className='spacer'></span>
				<span className='buttons' ref={buttons}></span>
			</div>
			<div className={`body ${role}`}>{chunkRenderer(m)}</div>
		</div>;
		if (hoveringMessage === m) updateButtons(m, buttons);
		return div;
	};

	vl = new VirtualList({
		itemHeight: innerHeight,
		overscan: 199,
		gap: 20,
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
