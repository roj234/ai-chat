// API request
import {createMarkdownStream} from "./markdown/markdown.js";
import {cloneNamed, getTextContent, jsonFetch, prettyError} from "./utils/utils.js";
import {
	abortCompletion,
	config,
	isLlamaCppBackend,
	lastScrollDirection,
	MessageRoles,
	messages,
	resumableCompletions,
	runningConversations,
	selectedConversation,
	Shared,
	state
} from "./states.js";
import {getTools, jsonPathOp, parseSkillMetadata, PLACEHOLDERS, runTools, set_title_body} from "./skills.js";
import {$stampLock, $state, $update, $watch, isReactive, unconscious} from "unconscious";
import {showToast} from "./components/Toast.js";
import {mergeReasoningDetails} from "./components/ThinkBlock.jsx";
import failure from "../media/failure.js";
import complete from "../media/complete.js";
import {appendBillingLog, isIDB, updateConversation} from "./database.js";
import {updateMessageUI} from "./components/MessageList.jsx";
import {BODY_PARAMETERS, defaultCoTPrompt, defaultSystemPrompt, defaultTitlePrompt} from "./settings.js";
import {createJsonStream} from "/common/StreamJsonSerializer.js";
import {createAntiSlopSampler} from "./anti-slop-sampler.js";
import SimpleModal from "./components/SimpleModal.jsx";
import {highlightJsonLike} from "./markdown/highlight.js";
import {updateConversationListUI} from "./components/ConversationList.jsx";
import {deepEntries} from "unconscious/common/json-schema-utils.js";
import {applyDelta, streamFetch} from "/common/openai-api-utils.js";
import {base64DecodeToUint8Array} from "unconscious/common/Base64.js";

export const statusBadge = <span />;
export const updateStatusText = (text, tone = '') => {
	statusBadge.textContent = text;
	statusBadge.className = 'badge ' + tone;
};

/**
 *
 * @return {Promise<string>}
 */
export async function submitUserChatMessage() {
	if (unconscious(abortCompletion)) return "error";
	abortCompletion.value = new AbortController();

	let markdownRenderer = createMarkdownStream();
	const {scroller} = Shared;
	let updateCount = 0;
	let content_;
	let waitingForContent;

	function updateMarkdown(content, force) {
		content_ = content;

		const currentIsThink = isReactive(content.think);
		const container = findStreamingContainer(currentIsThink);
		if (!container) {
			waitingForContent = currentIsThink;
			return true;
		}
		waitingForContent = 0;

		if (!force) {
			const details = container.closest("details:not([open])");
			if (details) {
				if (!details.classList.contains("m")) {
					details.classList.add("m");
					// only update when open
					details.addEventListener("click", () => updateMarkdown(content));
				}
				return;
			}

			if (updateCount) return;

			requestAnimationFrame(() => {
				const wasUpdatedAfterCheckpoint = updateCount > 1;
				updateCount = 0;
				if (wasUpdatedAfterCheckpoint) updateMarkdown(content);
			});
			updateCount++;
		}

		const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

		markdownRenderer(currentIsThink ? content.think.content : content.content, container);

		if (atBottom < 100 && !lastScrollDirection.value) scroller.vl.scrollTo(scroller.scrollHeight);
	}
	function callback(type, content) {
		if (selectedConversation.id !== conversation_.id) return;

		switch (type) {
			case MARKDOWN_APPEND:
				// noinspection UnnecessaryLocalVariableJS
				const flag = waitingForContent;
				if (updateMarkdown(content) && waitingForContent !== flag) break;
			return;
			case MARKDOWN_END: {
				if (content_) {
					updateCount = 0;
					updateMarkdown(content_, true);
					markdownRenderer();
				}
				if (null === content?.finish_reason) return;
			}
		}
		$update(updateMessageUI);
	}

	const messages_ = $stampLock(messages);
	const conversation_ = unconscious(selectedConversation);
	const abort_ = $state(unconscious(abortCompletion));
	/** @type {AiChat.LLMRequestContext} */
	const context = {};

	// _ApiRequest 会更新 abortCompletion
	// TODO 让 stampLock 支持这个
	let oldValue;
	$watch(abort_, () => {
		const newValue = unconscious(abort_);
		if (unconscious(abortCompletion) === oldValue) {
			abortCompletion.value = newValue;
		}
		oldValue = newValue;
	});

	runningConversations.set(conversation_.id, {
		abort: abort_,
		messages: messages_
	});
	$update(updateConversationListUI);

	try {
		const result = await executeCompletionRequest(
			conversation_, messages_,
			config.tools, config.additionalBody,
			abort_, callback,
			context
		);

		if (!result) return result; // false

		const promises = [];

		let finishReason = result.finish_reason;

		const assistantMessage = messages_.at(-1);

		const resumeObj = resumableCompletions[conversation_.id];
		if (finishReason !== 'error' || assistantMessage.error?.trim() !== "network error"/* fetch */) {
			if (resumeObj) {
				try {
					promises.push(jsonFetch(config.endpoint+"/abort/"+resumeObj.id, {
						key: config.accessToken,
						method: 'POST'
					}));
				} catch (e) {
					showToast("Abort接口调用失败\n"+e, 'error');
				}
				delete resumableCompletions[conversation_.id];
			}
		} else {
			if (resumeObj) {
				showToast("连接意外中止\n在"+(RESUME_TIMEOUT/60000)+"分钟内点击重试按钮可以无缝继续对话", 'error');
			}
		}

		const tone = FINISH_REASON_TONE[finishReason];
		const is_ok = tone != null;

		if ('interrupt' !== finishReason && 'loop' !== finishReason) {
			if ('error' !== finishReason) {
				if (!conversation_.title) {
					generateChatTitle(conversation_, messages_);
				}
			}

			if ('tool_calls' !== finishReason && config.sound) {
				if (config.sound === "always" || !document.hasFocus())
					is_ok ? complete() : failure();
			}
		}

		if (is_ok && assistantMessage.tool_calls) {
			if ((config.maxToolTurns && countAgenticTurns(messages_) >= config.maxToolTurns) || !await runTools(assistantMessage, conversation_)) {
				// 如果存在可能需要批准的工具调用
				finishReason = 'interrupt';
			}
			$update(updateMessageUI);
		}

		updateStatusText(FINISH_REASON_LABEL[finishReason], tone ?? 'error');

		const has_resp = result.request_id && (finishReason !== 'error' || result.input_tokens);
		if (has_resp || messageHasContent(assistantMessage)) {
			promises.push(updateConversation(conversation_, unconscious(messages_)));

			if (has_resp) {
				isIDB && await promises.at(-1).then(() => result.id = assistantMessage.id);
				promises.push(appendBillingLog(result));
			}
		}

		if (selectedConversation.id !== conversation_.id) {
			finishReason = 'interrupt'; // 如果不在前台就不自动执行
			showToast("对话 "+conversation_.title+"(#"+conversation_.id+") 已结束", tone ?? "error");
		}

		await Promise.all(promises);
		return finishReason;
	} finally {
		runningConversations.delete(conversation_.id);
		$update(updateConversationListUI);
		abort_.value = null;
	}
}

const FINISH_REASON_LABEL = {
	'tool_calls': '批准工具调用',
	'length': '长度限制',
	'stop': '完成',
	'error': '错误',
};
const FINISH_REASON_TONE = {
	'tool_calls': '',
	'stop': 'ok',
};

/**
 * @return {number}
 */
const countAgenticTurns = messages => {
	const arr = messages.value;
	let turns = 0;
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i].finish_reason !== "tool_calls") {
			break;
		}
		turns++;
	}
	return turns;
};

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]} messages
 */
const generateChatTitle = (conversation, messages) => {
	let s1 = getTextContent(messages[0]).slice(0, 512);

	const i = s1.indexOf("\n");
	conversation.title = i >= 0 && i < 30 ? s1.slice(0, i) : s1.slice(0, Math.min(s1.length, 30));

	let s2 = getTextContent(messages[1]).slice(0, 512);
	if (config.generateTitle !== true) return;

	updateStatusText('生成标题');

	jsonFetch(config.endpoint+'/chat/completions', {
		key: config.accessToken,
		body: JSON.stringify({
			model: config.titleModel,
			messages: [{
				role: "system",
				content: config.titlePrompt || defaultTitlePrompt,
			}, {
				role: "user",
				content: "对话摘要：\n用户:\n" + s1 + "\nLLM:\n" + s2
			}],
			max_tokens: 30,
			temperature: 0.7,
			stop: ["\n"],
			reasoning: {enabled: false},
			stream: false
		})
	}).then(json => {
		if (json.choices?.[0].finish_reason !== "stop") throw json;
		conversation.title = json.choices?.[0].message?.content;
		updateConversation(conversation);
	}).catch(err => {
		console.error(err);
		showToast("标题生成失败\n"+prettyError(err), 'error');
	});
};


export const MARKDOWN_APPEND = 2, MARKDOWN_END = 3;

export const findStreamingContainer = think => {
	const scroller = Shared.scroller;

	const bodyNode = scroller.children[0].children[0].lastElementChild?.querySelector(".body");
	if (bodyNode) {
		const children = bodyNode.children;
		const element = children[children.length - 1];
		if (element) {
			if (think) {
				if (element.matches(".think")) return element.lastElementChild;
			} else {
				if (element.matches(".md")) return element;
			}
		}
	}
};

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[] | import("unconscious").Reactive<AiChat.Message[]>} messages
 * @param {boolean=} allowTool
 * @param {Record<string, any>} additionalBody
 * @param {import("unconscious").Reactive<AbortController>} abortCompletion
 * @param {function(type?: number, content?: any): void} onProgress - null: refresh, T=Think, C=Content, E=End
 * @param {AiChat.LLMRequestContext} context
 * @return {Promise<false | AiChat.BillingLog>}
 */
function executeCompletionRequest(
	conversation, messages,
	allowTool, additionalBody,
	abortCompletion, onProgress,
	context
) {
	return new Promise((resolve, reject) => {
		let retryCount = 0;
		let lastRequest;

		context.retry = () => {
			abortCompletion.value = new AbortController();
			retryCount++;
			lastRequest.then(attempt);
		};

		const attempt = () => {
			const currentRetryCount = retryCount;
			lastRequest = sendCompletionRequest(
				conversation,
				messages,
				allowTool,
				additionalBody,
				unconscious(abortCompletion),
				onProgress,
				context
			).then((result) => {
				if (currentRetryCount === retryCount) {
					resolve(result);
				}
			}).catch((err) => {
				if (currentRetryCount === retryCount) {
					reject(err);
				}
			});
		};

		attempt();
	});
}

function messageHasContent(assistantMessage) {
	return assistantMessage.think?.content || assistantMessage.content || assistantMessage.tool_calls?.length;
}

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[] | import("unconscious").Reactive<AiChat.Message[]>} messages
 * @param {boolean=} allowTool
 * @param {Record<string, any>} additionalBody
 * @param {AbortController} abortCompletion
 * @param {function(type?: number, content?: any): void} onProgress - null: refresh, T=Think, C=Content, E=End
 * @param {AiChat.LLMRequestContext} context
 * @return {Promise<false | AiChat.BillingLog>}
 */
async function sendCompletionRequest(
	conversation, messages,
	allowTool, additionalBody,
	abortCompletion, onProgress,
	context
) {
	let {
		/** @type {string} */
		url,
		/**
		 * @type {{headers: {Authorization: string, "Content-Type": string}, body: string | ReadableStream}}
		 */
		data,
		/** @type {AiChat.AssistantMessage} */
		assistantMessage,
		/** @type {AiChat.AssistantMessage} */
		initialAssistantMessage,
		/** @type {string | Error} */
		error,
	} = await buildCompletionPayload(
		conversation, messages,
		allowTool, additionalBody,
		context
	).catch(error => {
		return {error};
	});

	if (abortCompletion.signal.aborted) return false;

	if (assistantMessage) {
		delete assistantMessage.error;
		assistantMessage.finish_reason = '';
		onProgress?.();
	} else {
		messages.push(assistantMessage = {
			role: 'assistant',
			content: '',
			model: config.model,
			id: -1,
			finish_reason: ''
		});
	}

	if (config.reviewRequest && !error && data.body) {
		error = await new Promise((resolve) => {
			SimpleModal({
				title: "预览请求体",
				message: <div style={"max-height:50vh;overflow:auto"} dangerouslySetInnerHTML={highlightJsonLike(data.body, 1e6, 30000)} />,
				onConfirm() {resolve();},
				onCancel() {
					resolve("取消操作");
					onProgress?.();
				},
			});
		})
	}

	if (onProgress) scrollToBottom();

	if (error) {
		if (config.sound) failure();
		updateStatusText('错误', 'error');

		assistantMessage.error = error;
		assistantMessage.finish_reason = 'error';
		return false;
	}

	let finishReason;
	let startTime = Date.now();
	/** @type {Partial<AiChat.BillingLog>} */
	const log = { time: startTime, provider: (config.provider || config.name || config.endpoint) };

	let genImages = [];

	let manualCoTCloseTag;
	let thinkState;
	if ((thinkState = assistantMessage.think) && !assistantMessage.content) {
		thinkState.start = startTime;
		const format = thinkState.format;
		manualCoTCloseTag = format.startsWith("m") && "</"+format.slice(1)+">\n";
		thinkState = assistantMessage.think = $state(thinkState);
		requestAnimationFrame(() => {
			onProgress?.(MARKDOWN_APPEND, assistantMessage);
		});
	}

	const endThinking = () => {
		thinkState.duration += Date.now() - thinkState.start;
		//thinkState.content = thinkState.content.trimEnd();
		delete thinkState.start;
		delete thinkState.index;
		thinkState = assistantMessage.think = {...thinkState};
	};

	updateStatusText('请求中');

	// Request
	try {
		let resumeObj;
		await streamFetch(url, {
			...data,
			key: config.accessToken,
			signal: abortCompletion.signal
		}, json => {
			if (config.logSSE) console.log("SSE response", json);

			if (json.timings) {
				const {predicted_per_second, predicted_n} = json.timings;

				if (json.prompt_progress) {
					const {processed, total} = json.prompt_progress;

					updateStatusText("预填充: "+(processed / total * 100).toFixed(2)+"%");
					//assistantMessage[PROMPT_PROGRESS] = processed / total;
					//onProgress?.();
					return;
				}
				updateStatusText("生成中, "+predicted_n+" Tokens, "+predicted_per_second.toFixed(2)+"TPS");
			}

			if (!log.request_id) {
				updateStatusText('生成中');

				const {id, model, resumable} = json;

				onProgress?.();

				log.request_id = id;
				log.model = model;

				let firstTokenTime = Date.now();
				if (json.resumable) {
					startTime = resumable.start;
					firstTokenTime = resumable.ft;

					if (thinkState) thinkState.start = startTime;
					if (!resumable.end && null != conversation.id) resumeObj = resumableCompletions[conversation.id] = { id };
				}

				log.latency = firstTokenTime - startTime;
				assistantMessage.time = firstTokenTime;
				assistantMessage.model = model;
			}
			if (resumeObj) resumeObj.time = Date.now();

			const [
				/** @type {OpenAI.ChatChoice | OpenAI.TextChoice} */
				chunk
			] = json.choices;

			if (!finishReason) finishReason = chunk?.finish_reason;
			if (finishReason) {
				log.duration = Date.now() - startTime;
				extractUsageMetrics(json, log);
			}

			if (!chunk) return;

			/** @type {string} */
			let text, reasoning_text;
			let reasoning_format  = 'r';

			if (config.mode === 'chat') {
				const {
					/** @type {Partial<OpenAI.AssistantMessage>} */
					delta
				} = chunk;
				if (!delta) return;

				if (delta.role) assistantMessage.role = delta.role;
				if (delta.images) genImages.push(...delta.images);
				text = delta.content;
				reasoning_text = delta.reasoning;

				const reasoningDetails = delta.reasoning_details;
				if (reasoningDetails) {
					if (!assistantMessage.reasoning_details) {
						assistantMessage.reasoning_details = reasoningDetails;
					} else {
						assistantMessage.reasoning_details.push(...reasoningDetails);
					}
					reasoning_format = 'rd';
				} else if (delta.reasoning_content) {
					// but I cant submit a PR
					reasoning_text = delta.reasoning_content;
					reasoning_format = 'rc';
				}

				if (delta.tool_calls) {
					let toolCalls = assistantMessage.tool_calls;
					if (!toolCalls) {
						toolCalls = assistantMessage.tool_calls = [];
						assistantMessage.tool_responses = [];
					}

					let hasNewToolCalls;
					for (const call of delta.tool_calls) {
						if (!call.id) {
							const last = toolCalls[toolCalls.length-1];
							if (last) {
								applyDelta(unconscious(last), call);
								$update(last);
								continue;
							}
						}
						delete call.index;
						toolCalls.push($state(call));
						hasNewToolCalls = true;
					}
					if (hasNewToolCalls) onProgress?.(MARKDOWN_END);
				}
			} else {
				text = chunk.text;
				if (!text) return;
			}

			if (context.antiSlop?.sample(chunk, assistantMessage)) {
				throw "retry";
			}

			let content = assistantMessage.content + (text || "");
			if (config.reasoning === false && !manualCoTCloseTag && (manualCoTCloseTag = /^\s*<(thinking|think|thought|reasoning)>/i.exec(content))) {
				reasoning_text = content.slice(manualCoTCloseTag[0].length);
				manualCoTCloseTag = manualCoTCloseTag[1];
				reasoning_format = "m"+manualCoTCloseTag;
				manualCoTCloseTag = "</"+manualCoTCloseTag+">\n";

				let pos = content.indexOf(manualCoTCloseTag);
				if (pos < 0) {
					content = "";
				} else {
					reasoning_text = reasoning_text.slice(0, pos);
					content = content.slice(pos + manualCoTCloseTag.length);
				}
			}

			continueThinking:
			if (reasoning_text != null) {
				if (!thinkState) {
					thinkState = assistantMessage.think = $state({
						start: resumeObj ? (startTime+log.latency) : Date.now(),
						duration: 0,
						index: 0,
						content: reasoning_text,
						format: reasoning_format
					});
					if (assistantMessage.content || assistantMessage.tool_calls) endThinking();
				} else if (isReactive(thinkState)) {
					thinkState.content += reasoning_text;
				} else if (thinkState.content.trimEnd() !== reasoning_text.trimEnd()) {
					console.warn("未预料的思考块", thinkState);
				}
			} else if (isReactive(thinkState)) {
				if (manualCoTCloseTag) {
					let index = thinkState.index;

					const thinkContent = thinkState.content += content;
					content = "";

					while (true) {
						let nextIndex = thinkContent.indexOf("<", index);
						if (nextIndex < 0) {
							thinkState.index = thinkContent.length;
							break continueThinking;
						}

						if (thinkContent.length < nextIndex + manualCoTCloseTag.length) {
							thinkState.index = nextIndex;
							break continueThinking;
						}

						if (thinkContent.startsWith(manualCoTCloseTag, nextIndex)) {
							thinkState.content = thinkContent.slice(0, nextIndex);
							content = thinkContent.slice(nextIndex + manualCoTCloseTag.length);
							break;
						}

						index = nextIndex + 1;
					}
				}

				if (content) endThinking(thinkState);
			}

			assistantMessage.content = content;
			if (!assistantMessage.tool_calls) onProgress?.(MARKDOWN_APPEND, assistantMessage);
		});

		if (!finishReason) {
			finishReason = 'error';
			assistantMessage.error = "network error";
		}
	} catch (err) {
		if (err.name === 'AbortError') {
			updateStatusText('已取消');
			finishReason = "interrupt";
		} else {
			abortCompletion.abort();
			if (err !== "retry") {
				finishReason = 'error';

				// 即便服务端Session过期了，也不要清除已经生成的内容
				if (initialAssistantMessage && !messageHasContent(assistantMessage)) {
					assistantMessage = messages[messages.length-1] = initialAssistantMessage;
				}

				if (config.sound) failure();
				updateStatusText('错误', 'error');
				console.error(err);
				if (err.status) err = `API错误 ${err.status}\n${err.message}`;
				assistantMessage.error = prettyError(err);
			}
		}
	} finally {
		streamResponseCompleted(assistantMessage, genImages);

		assistantMessage.finish_reason = finishReason;
		log.finish_reason = finishReason;

		onProgress?.(MARKDOWN_END, assistantMessage);
	}

	return log;
}

const scrollToBottom = () => {
	requestAnimationFrame(() => {
		const {scroller} = Shared;
		scroller.vl.scrollTo(scroller.scrollHeight);
		lastScrollDirection.value = false;
	});
};

// 第一个见 sendCompletionRequest 函数
const allowPrefillFinishReasons = [null, "length", "interrupt", "error"];

/**
 *
 * @param {Partial<AiChat.Conversation>} conversation
 * @param {AiChat.Message[]} messages
 * @param {boolean} allowTools
 * @param {Record<string, any>} additionalBody
 * @param {AiChat.LLMRequestContext} context
 * @return {Promise<{assistantMessage: AiChat.AssistantMessage, data: {headers: {Authorization: string, "Content-Type": string}, body: string | function(): ReadableStream}, url: string}>}
 */
async function buildCompletionPayload(
	conversation, messages,
	allowTools, additionalBody,
	context
) {
	/**
	 * @type {OpenAI.Message[]}
	 */
	const json_messages = [];

	/**
	 * @type {AiChat.AssistantMessage}
	 */
	let initialAssistantMessage= messages.at(-1);
	if (!initialAssistantMessage) throw "No message to continue";
	else if (initialAssistantMessage.role !== 'assistant') initialAssistantMessage = null;

	let assistantMessage = initialAssistantMessage;
	/** @type {boolean} */
	let isPrefill;
	if (initialAssistantMessage) {
		const finishReason = assistantMessage.finish_reason;
		if (!allowPrefillFinishReasons.includes(finishReason)) assistantMessage = null;
		else if (finishReason === 'error' || !config.canPrefill) {
			messages.pop();
			assistantMessage = null;
		} else {
			isPrefill = true;
		}
	}

	let toolsUsed = conversation.activatedModules?.size > 0;
	let callbacks = [];
	for (let j = 0; j < messages.length; j++){
		const m = messages[j];

		const compose = MessageRoles[m.role]?.compose;
		if (compose) {
			compose(m, json_messages, callbacks, j, messages.length, conversation);
			continue;
		}

		const json_msg = cloneNamed(m, ["role", "content", "tool_calls", "reasoning_details"]);
		json_messages.push(json_msg);

		const {tool_calls, tool_responses, think} = m;
		if (tool_calls) {
			toolsUsed = true;

			updateStatusText("正在执行工具");
			await runTools(m, conversation, true);

			for (let i = 0; i < tool_calls.length; i++) {
				json_messages.push({
					role: "tool",
					tool_call_id: tool_calls[i].id,
					content: tool_responses[i].content,
				});
			}
		}

		const isPrefill = m === assistantMessage;
		const prefillPath = config.prefillPath;
		if (isPrefill && prefillPath) {
			const [path, value = "true"] = prefillPath.split(",");
			jsonPathOp(json_msg, path, "set", JSON.parse(value));
			// json_msg.prefix = true;
		}
		const format = think?.format;
		if (format && (config.stripCoT !== true || isPrefill)) {
			const content = think.content;
			if (format === "r") json_msg.reasoning = content;
			if (format === "rc") json_msg.reasoning_content = content;
			if (format[0] === "m" && (config.stripCoT !== "m" || isPrefill)) {
				const tag = think.format.slice(1);
				json_msg.content = "<"+tag+">" + content + (m.content ? "</"+tag+">\n" + m.content : "");
			}
		} else {
			delete json_msg.reasoning_details;
		}
	}

	// Prepare request body
	const headers = {
		//'HTTP-Referer': location.origin,
		//'X-Title': 'AIChat',
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${config.accessToken}`
	};
	let path = '/chat/completions';

	const resumeObj = resumableCompletions[conversation.id];
	if (resumeObj) {
		//delete resumableCompletions[conversation.id];
		if (Date.now() - resumeObj.time < RESUME_TIMEOUT) {
			return {
				url: config.endpoint+'/resume/'+resumeObj.id,
				data: {headers},
				assistantMessage,
				initialAssistantMessage
			};
		}
	}

	/**
	 * @type {Partial<OpenAI.ChatCompletionRequest>}
	 */
	let body = {
		model: config.model,
		stream: true
	};

	for (const {id, body_id, _omit} of BODY_PARAMETERS) {
		const v = config[id];
		if (v !== undefined && v !== _omit) {
			body[body_id] = v;
		}
	}

	let toolPrompt;
	if (config.mode === 'completions') {
		path = '/completions';
		// Build a single prompt from conversation (with roles)
		body.prompt = state.completionTemplate(json_messages);
	} else {
		body.messages = json_messages;

		if (config.modalities?.includes("tool")) {
			if (config.generateTitle === "tool" && !selectedConversation.title) {
				// TODO allow set_title tool and provide system prompt ?
				body.tools = [set_title_body];
			}

			// TODO use allowTools / allowNewTools or just provide?
			if (allowTools || toolsUsed) {
				[body.tools, toolPrompt] = await getTools(conversation, allowTools);
				// is this default=true for llama.cpp ?
				body.parallel_tool_calls = true;
				if (!allowTools) body.tool_choice = "none";
				else if (typeof allowTools === "object") body.tool_choice = allowTools;
			}
		}

		const reasoningEffort = config.reasoning;
		const enableThink = isThinkingEnabled() && reasoningEffort;
		const [reasoningPath, reasoningEnabledValue = 'true', reasoningDisabledValue = 'false'] = (config.reasoningPath||"reasoning.enabled").split(",");

		if (config.forceThink !== 0) {
			jsonPathOp(body, reasoningPath, "set", JSON.parse(enableThink?reasoningEnabledValue:reasoningDisabledValue));
			if (enableThink) {
				const [reasoningEffortPath, reasoningEffortType = 's'] = (config.reasoningEffortPath || "reasoning.effort").split(",");
				let fieldValue = reasoningEffort;
				if (reasoningEffortType === 'i') {
					if (reasoningEffort === "minimal") {
						fieldValue = 1024;
					} else {
						fieldValue = ({
							"low": 0.2,
							"medium": 0.5,
							"high": 0.8,
						}[reasoningEffort]) * body.max_tokens;
					}
				}
				jsonPathOp(body, reasoningEffortPath, "set", fieldValue);
			}
		}
	}
	if (additionalBody) Object.assign(body, additionalBody);

	let [systemPrompt, systemBody] = buildSystemPrompt(conversation, config.systemPrompt || defaultSystemPrompt, toolPrompt);
	if (systemPrompt) {
		if (json_messages[0]?.role !== 'system')
			json_messages.unshift({role: 'system', content: systemPrompt});
	}
	if (systemBody) Object.assign(body, systemBody);

	for (const callback of callbacks) {
		callback(messages, json_messages, body, isPrefill);
	}

	block:
	if (config.antiSlop) {
		if (!context.retry) {showToast("这个调用不支持AntiSlop采样"); break block;}

		// 在 llama.cpp 上TPS高得多，而且我本来就只需要采样器最后输出的可能候选
		if (isLlamaCppBackend) {
			body.post_sampling_probs = true;
			body.n_probs = 5;
		} else {
			if (!config.canPrefill) throw "模型必须支持预填充和 lobprobs 以使用反语法约束采样";
			body.logprobs = true;
			// 不支持的其实也能回滚吧，先不管了
			body.top_logprobs = 5;
		}

		if (!context.antiSlop)
			context.antiSlop = createAntiSlopSampler(body.top_p ?? 1, body.min_p ?? 0, config.antiSlop, context);
	}

	if (isLlamaCppBackend) {
		body.return_progress = true;
		body.timings_per_token = true;
	}

	let outputBody;
	const {streamDuplex, sseBlobProxy} = config;
	const useH2Stream = streamDuplex ? 'half' : undefined;
	if (useH2Stream) {
		outputBody = createJsonStream(body, sseBlobProxy);
	} else {
		const promises = [];
		const mapping = new Map;
		for (const [val] of deepEntries(body)) {
			const type = val?.constructor;
			if (type === Blob || type === File) {
				const {name, type, size, hash} = val;
				const isTextFile = type.startsWith("text/") || type === "application/json";
				const isAudio = type.startsWith("audio/");

				if (size === 0) throw "文件"+name+"的数据不完整或已损坏。请尝试重新上传";
				/*if (hash && sseBlobProxy && DB_MODE !== "local") {
					path += "?blobProxy";
					mapping.set(val, {
						$: "Blob"+(isTextFile? "Raw" : isAudio ? "RawDataURL" : "DataURL"),
						url: val.toUrl(),
						type
					});
					continue;
				}*/

				promises.push(val[isTextFile?"text":"toDataURL"]().then(str => {
					if (isAudio) str = str.slice(str.indexOf(",")+1);
					mapping.set(val, str);
				}));
			}
		}
		await Promise.all(promises);

		outputBody = JSON.stringify(body, (_, value) => mapping.get(value) ?? value);
	}

	const url = config.endpoint+path;
	return {
		url,
		data: {
			headers,
			body: outputBody,
			duplex: useH2Stream
		},
		assistantMessage
	};
}

const isThinkingEnabled = () => (typeof config.forceThink === "boolean" ? config.forceThink : config.think);

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {string} prompt
 * @param {string} toolPrompt
 * @return {[prompt: string, body: {}]}
 */
export const buildSystemPrompt = (conversation, prompt, toolPrompt) => {
	let body = {};

	if (prompt.startsWith("---\n")) {
		const [meta, content] = parseSkillMetadata(prompt);

		let activatedModules = conversation.activatedModules;
		// only process at initial
		if (!activatedModules) {
			const allowedTools = meta.allowedTools;
			if (allowedTools) {
				conversation.activatedModules = new Set(allowedTools);
				conversation.allowedTools = new Set(allowedTools);
			}

			const disabledTools = meta.disabledTools;
			if (disabledTools) {
				if (!conversation.activatedModules) conversation.activatedModules = new Set(disabledTools);
				else disabledTools.forEach(v => conversation.activatedModules.add(v));
			}
		}

		for (const key of ["tool_choice", "reasoning"]) {
			if (key in meta) body[key] = meta[key];
		}

		prompt = content;
	}

	const transform = (prompt) => prompt.replaceAll(/\{\{(.+?)}}/g, (text, id) => {
		switch (id) {
			case "think":
				return isThinkingEnabled() && config.reasoning === false ? (config.CoTPrompt || defaultCoTPrompt) : "";
			case "tools":
				return transform(toolPrompt || "");
		}

		let val = PLACEHOLDERS[id];
		if (val != null) {
			if (typeof val === "function")
				val = val();
			return val;
		}

		return text;
	}).trim();

	return [transform(prompt), body];
};

/**
 *
 * @param {OpenAI.BaseResponse} json
 * @param {AiChat.BillingLog} log
 * @return {string}
 */
const extractUsageMetrics = (json, log) => {
	console.log("usage", json);

	const {provider, usage, timings} = json;

	if (provider && log.provider.indexOf('/') < 0) log.provider += "/"+provider;

	if (usage) {
		let {
			prompt_tokens, prompt_tokens_details = {},
			completion_tokens, completion_tokens_details = {},
			cost
		} = usage;

		const {reasoning_tokens = 0} = completion_tokens_details;
		const {cached_tokens = 0, cache_write_tokens = 0} = prompt_tokens_details;

		log.input_tokens = prompt_tokens - cached_tokens;
		log.output_tokens = completion_tokens;

		if (cached_tokens) log.cached_tokens = cached_tokens;
		if (reasoning_tokens) log.reasoning_tokens = reasoning_tokens;
		if (cache_write_tokens) log.cache_write_tokens = cache_write_tokens;
		if (cost) {
			log.cost = cost;
			log.currency = "USD";
		}
	}

	if (timings) {
		let {cache_n, prompt_n, predicted_n, predicted_per_second} = timings;
		const input_tokens = prompt_n + cache_n;

		log.provider = 'llama.cpp';
		log.input_tokens = input_tokens;
		log.output_tokens = predicted_n;
		log.cached_tokens = cache_n;
		log.tps = predicted_per_second;
	}
};

/**
 *
 * @param {AiChat.AssistantMessage} assistantMessage
 * @param {OpenAI.ImagePart[]} genImages
 */
const streamResponseCompleted = (assistantMessage, genImages) => {
	if (assistantMessage.id === -1) delete assistantMessage.id;

	const {reasoning_details, tool_calls, think, content} = assistantMessage;

	if (reasoning_details) {
		let hasText;
		[assistantMessage.reasoning_details, hasText] = mergeReasoningDetails(reasoning_details);
		if (hasText) delete assistantMessage.think?.content;
	}
	if (tool_calls) assistantMessage.tool_calls = tool_calls.map(unconscious);

	if (isReactive(think)) {
		think.duration += Date.now() - think.start;
		delete think.start;

		assistantMessage.think = {...think};
	}

	if (genImages?.length) {
		const arr = [];
		if (content) arr.push({
			type: "text",
			text: assistantMessage.content
		});
		genImages.forEach(part => {
			const url = part.image_url.url;
			if (typeof url === 'string') {
				const idx = url.indexOf(',');
				if (idx > 0) {
					const type = url.slice(5, url.indexOf(';'));
					part.image_url.url = new Blob([base64DecodeToUint8Array(url.slice(idx+1))], {type});
				}
			}
		});
		arr.push(...genImages);
		assistantMessage.content = arr;
	}
};

const DISABLE_ALL = /*#__PURE__*/ new Set(["*"]);

export class APIRequest {
	/** @type {import("unconscious").Reactive<AbortController>} */
	abort = $state();

	/**
	 *
	 * @param {AiChat.Message[]} messages
	 * @param {string[]=} tools
	 * @param {Record<string, any>=} body
	 */
	constructor(messages, tools, body) {
		/** @type {AiChat.Conversation} */
		this.conversation = {
			api: 1,
			activatedModules: DISABLE_ALL,
			allowedTools: new Set(tools || []),
		};
		/** @type {AiChat.Message[]} */
		this.messages = messages;
		/** @type {Record<string, any>} */
		this.body = {
			...config.additionalBody,
			...body
		};
	}

	/**
	 *
	 * @param {AiChat.Message | AiChat.Message[] | string} userText
	 * @param {function(type?: number, content?: AiChat.AssistantMessage): void=} onProgress
	 * @return {Promise<[AiChat.AssistantMessage, AiChat.BillingLog]>}
	 */
	async call(userText, onProgress) {
		const {abort, messages, conversation, body} = this;
		if (unconscious(abort)) throw "Already generating";
		abort.value = new AbortController();

		try {
			if (typeof userText === "string") messages.push({role: 'user', content: userText, time: Date.now()});
			else if (Array.isArray(userText)) messages.push(...userText);
			else if (userText) messages.push(userText);

			const context = {};
			const result = await executeCompletionRequest(
				conversation, messages,
				conversation.allowedTools.size, body,
				abort, onProgress,
				context
			);

			const finishReason = result.finish_reason;
			const assistantMessage = messages.at(-1);

			if (finishReason === "error")
				throw assistantMessage.error || "调用失败:"+result;

			return [assistantMessage, result];
		} finally {
			abort.value = null;
		}
	}

	interrupt() {
		const abort = unconscious(this.abort);
		if (abort) abort.abort();
	}
}