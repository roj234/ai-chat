// API request
import {markdownStreamParser} from "./markdown/markdown.js";
import {cloneNamed, getTextContent, jsonFetch, prettyError, streamFetch} from "./utils/utils.js";
import {
	abortCompletion,
	config,
	isLlamaCppBackend,
	isMyLlamaCppBackend,
	lastScrollDirection,
	MessageRoles,
	messages,
	resumableCompletions,
	runningConversations,
	selectedConversation,
	Shared,
	state
} from "./states.js";
import {getTools, parseSkillMetadata, runTools, set_title_body} from "./skills.js";
import {$stampLock, $state, $update, isReactive, unconscious} from "unconscious";
import {showToast} from "./components/Toast.js";
import {mergeReasoningDetails} from "./components/ThinkBlock.jsx";
import failure from "../media/failure.js";
import complete from "../media/complete.js";
import {appendBillingLog, updateConversation} from "./database.js";
import {updateMessageUI} from "./components/MessageList.jsx";
import {BODY_PARAMETERS, defaultCoTPrompt, defaultSystemPrompt} from "./settings.js";
import {jsonEncode} from "/vendor/stream-json.js";
import {AntiSlop} from "./antiSlop.js";
import SimpleModal from "./components/SimpleModal.jsx";
import {highlightJsonLike} from "./markdown/highlight.js";
import {updateConversationListUI} from "./components/ConversationList.jsx";
import {deepEntries} from "../vendor/jsonSchema.js";

export function setStatus(text, tone = '') {
	Shared.statusBadge.textContent = text;
	Shared.statusBadge.className = 'badge ' + tone;
}

function isThinkingEnabled() {
	return (typeof config.forceThink === "boolean" ? config.forceThink : config.think);
}

/**
 *
 * @param {Partial<AiChat.Conversation>} conversation
 * @param {AiChat.Message[]} messages
 * @param {boolean=} allowTools
 * @param {Record<string, any>=} additionalBody
 * @param {AntiSlop=} antiSlop
 * @return {Promise<{assistantMessage: AiChat.AssistantMessage, data: {headers: {Authorization: string, "Content-Type": string}, body: string | function(): ReadableStream}, url: string, antiSlop: AntiSlop}>}
 */
async function composeMessages(conversation, messages, allowTools, additionalBody, antiSlop) {
	/**
	 * @type {OpenAI.Message[]}
	 */
	const json_messages = [];

	let systemPrompt;
	if ((systemPrompt = processSystemPrompt(conversation, config.systemPrompt || defaultSystemPrompt)).prompt) {
		if (messages[0]?.role !== 'system')
			json_messages.push({role: 'system', content: systemPrompt.prompt});
	}

	/**
	 * @type {AiChat.AssistantMessage}
	 */
	let initialAssistantMessage= messages.at(-1);
	if (!initialAssistantMessage) throw "No message to continue";
	else if (initialAssistantMessage.role !== 'assistant') initialAssistantMessage = null;

	let assistantMessage = initialAssistantMessage;
	if (initialAssistantMessage) {
		const isAutomatic = assistantMessage.finish_reason === "tool_calls";

		if (isAutomatic) assistantMessage = null;
		else if (!config.allowContinue || (!isMyLlamaCppBackend && (assistantMessage.think || !assistantMessage.content))) {
			if (antiSlop) throw "AntiSlop不支持的预填充方式（尝试禁用思考？）";
			messages.pop();
			assistantMessage = null;
		}
	}

	let toolsUsed = conversation.activatedModules?.size > 0;
	let callbacks = [];
	for (const m of messages) {
		const customHandler = MessageRoles[m.role];
		if (customHandler) {
			customHandler.compose?.(m, json_messages, callbacks);
			continue;
		}

		const json_msg = cloneNamed(m, ["role", "content", "tool_calls", "reasoning_details"]);
		json_messages.push(json_msg);

		if (m.tool_calls) {
			toolsUsed = true;

			setStatus("正在执行工具");
			await runTools(m, true);

			for (let i = 0; i < m.tool_calls.length; i++) {
				const call = m.tool_calls[i];
				const resp = m.tool_responses[i];
				json_messages.push({
					role: "tool",
					tool_call_id: call.id,
					content: resp.content,
				});
			}
		}

		const think = m.think;
		const format = think?.format;
		if (format && config.trimCoT !== true) {
			const content = think.content;
			if (format === "r") json_msg.reasoning = content;
			if (format === "rc") json_msg.reasoning_content = content;
			if (format[0] === "m" && config.trimCoT !== "m") {
				const tag = think.format.substring(1);
				json_msg.content = "<"+tag+">" + content + "</"+tag+">\n" + json_msg.content;
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
		delete resumableCompletions[conversation.id];
		if (Date.now() - resumeObj.time < RESUME_TIMEOUT) {
			return {
				url: config.endpoint+'/resume/'+resumeObj.id,
				data: { headers },
				antiSlop,
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

	for (const callback of callbacks) {
		callback(messages, json_messages, body);
	}

	if (config.mode === 'completions') {
		path = '/completions';
		// Build a single prompt from conversation (with roles)
		body.prompt = state.completionTemplate(json_messages);
	} else {
		body.messages = json_messages;

		if (allowTools || toolsUsed) {
			body.tools = getTools(conversation);
			// is this default=true for llama.cpp ?
			body.parallel_tool_calls = true;
			if (!allowTools) body.tool_choice = "none";
			else if (allowTools !== true) body.tool_choice = allowTools;
		} else if (config.generateTitle === "tool" && !selectedConversation.title) {
			//body.tool_choice = {type: "function", function: {name: "set_title"}};
			body.tools = [set_title_body];
		}

		const shouldThink = isThinkingEnabled() && config.reasoning;
		body.reasoning = {enabled: !!shouldThink};
		if (shouldThink) {
			if (config.reasoning === "minimal") {
				body.reasoning.max_tokens = 1024;
			} else {
				body.reasoning.effort = config.reasoning;
				/*body.reasoning.max_tokens = ({
					"low": 0.2,
					"medium": 0.5,
					"high": 0.8,
				}[config.reasoning]) * body.max_tokens;*/
			}
		}
	}

	for (const {id, body_id, _omit} of BODY_PARAMETERS) {
		const v = config[id];
		if (v !== undefined && v !== _omit) {
			body[body_id] = v;
		}
	}
	for (const key of ["stop", "logit_bias"]) {
		if (state[key]) body[key] = state[key];
	}
	if (systemPrompt) Object.assign(body, systemPrompt.body);
	if (additionalBody) Object.assign(body, additionalBody);

	block:
	if (state.antiSlop) {
		if (conversation.api) {showToast("结构化调用暂不支持AntiSlop采样器"); break block;}

		// 在 llama.cpp 上TPS高得多，而且我本来就只需要采样器最后输出的可能候选
		if (isLlamaCppBackend) {
			body.post_sampling_probs = true;
			body.n_probs = 5;
		} else {
			if (!config.allowContinue) throw "模型必须支持预填充和 lobprobs 以使用反语法约束采样";
			body.logprobs = true;
			// 不支持的其实也能回滚吧，先不管了
			body.top_logprobs = 5;
		}

		if (!antiSlop)
			antiSlop = new AntiSlop(body.top_p ?? 1, body.min_p ?? 0, state.antiSlop);
	}

	if (isLlamaCppBackend) {
		body.return_progress = true;
		body.timings_per_token = true;
	}

	let outputBody;
	const useH2Stream = false && config.useH2Stream ? 'half' : undefined;
	if (useH2Stream) {
		// WIP
		outputBody = () => new ReadableStream({
			async start(controller) {
				for await (const chunk of jsonEncode(body)) {
					controller.enqueue(chunk);
				}
				controller.close();
			}
		});
	} else {
		const promises = [];
		const mapping = new Map;
		for (const [val] of deepEntries(body)) {
			if (val instanceof Blob) {
				if (val.size === 0) throw "文件数据不完整或已损坏。请尝试重新上传";

				const type = val.type;
				const isTextFile = type.startsWith("text/") || type === "application/json";
				promises.push(val[isTextFile?"text":"toDataURL"]().then(str => {
					if (type.startsWith("audio/")) {
						str = str.substring(str.indexOf(",")+1);
					}

					mapping.set(val, str);
				}));
			}
		}
		await Promise.all(promises);

		outputBody = JSON.stringify(body, (_, value) => {
			return mapping.get(value) ?? value;
		});
	}

	const url = config.endpoint+path;
	return {
		url,
		data: {
			headers,
			body: outputBody,
			duplex: useH2Stream
		},
		antiSlop,
		assistantMessage
	};
}

function processSystemPrompt(conversation, prompt) {
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

	prompt = prompt.replaceAll(/\{\{(.+?)}}/g, (text, match) => {
		switch (match) {
			case "think":
				return isThinkingEnabled() && config.reasoning === false ? (config.CoTPrompt || defaultCoTPrompt) : "";
		}
		return text;
	}).trim();

	return {prompt, body};
}

function applyDelta(chunk, delta) {
	for (const item in delta) {
		if (delta[item] == null) continue;

		if (typeof(delta[item]) === "object") {
			if (!chunk[item])
				chunk[item] = Array.isArray(delta[item]) ? [] : {};
			applyDelta(chunk[item], delta[item]);
		} else if (null == chunk[item]) {
			chunk[item] = delta[item];
		} else {
			chunk[item] += delta[item];
		}
	}
}

/**
 *
 * @param {OpenAI.BaseResponse} json
 * @param {AiChat.BillingLog} billingLog
 * @return {string}
 */
function getStats(json, billingLog) {
	if (json.usage) {
		let {
			prompt_tokens, prompt_tokens_details = {},
			completion_tokens, completion_tokens_details = {},
			cost
		} = json.usage;

		const {reasoning_tokens} = completion_tokens_details;
		const {cached_tokens, cache_write_tokens} = prompt_tokens_details;

		billingLog.provider = json.provider;
		billingLog.input_tokens = prompt_tokens - cached_tokens;
		billingLog.output_tokens = completion_tokens;

		if (cached_tokens) {
			billingLog.cached_tokens = cached_tokens;
		}
		if (reasoning_tokens) {
			billingLog.reasoning_tokens = reasoning_tokens;
		}
		if (cache_write_tokens) {
			billingLog.cache_write_tokens = cache_write_tokens;
		}
		if (cost) {
			billingLog.cost = cost;
			billingLog.currency = "USD";
		}
	}

	if (json.timings) {
		let {cache_n, prompt_n, predicted_n, predicted_per_second} = json.timings;
		const input_tokens = prompt_n + cache_n;

		billingLog.provider = 'llama.cpp';
		billingLog.input_tokens = input_tokens;
		billingLog.output_tokens = predicted_n;
		billingLog.cached_tokens = cache_n;
		billingLog.cost = 0;
		billingLog.tps = predicted_per_second;
	}
}

const finish_reason_names = {
	'tool_calls': '批准工具调用',
	'length': '长度限制',
	'stop': '完成',
	'error': '错误',
};
const finish_reason_tone = {
	'tool_calls': '',
	'stop': 'ok',
};

export function getMarkdownContainer(think) {
	const scroller = Shared.scroller;

	const bodyNode = scroller.children[0].children[0].lastElementChild?.querySelector(".body");
	if (bodyNode) {
		const children = bodyNode.children;
		const element = children[children.length - 1];
		if (think) {
			if (element.matches(".think")) return element.lastElementChild;
		} else {
			if (element.matches(".content")) return element;
		}
	}
}

/**
 *
 * @param {string | OpenAI.ContentPart[]=} userText
 * @param {AntiSlop=} antiSlop
 * @return {Promise<string>}
 */
export async function sendUserChatMessage(userText, antiSlop) {
	if (abortCompletion.value) return "error";
	abortCompletion.value = new AbortController();

	let markdownRenderer = markdownStreamParser();
	const {scroller} = Shared;
	let updateCount = 0;
	let content_;
	let waitingForContent;

	function updateMarkdown(content, force) {
		content_ = content;

		const currentIsThink = isReactive(content.think);
		const container = getMarkdownContainer(currentIsThink);
		if ((waitingForContent = !container)) return true;

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
		if (selectedConversation.id !== conversation.id) return;

		switch (type) {
			case MD_APPEND:
				// noinspection UnnecessaryLocalVariableJS
				const flag = waitingForContent;
				if (updateMarkdown(content) && !flag) break;
			return;
			case MD_END: {
				if (content_) {
					updateCount = 0;
					updateMarkdown(content_, true);
					markdownRenderer();
				}
			}
		}
		$update(updateMessageUI);
	}

	const messages_ = $stampLock(messages);
	const conversation = unconscious(selectedConversation);
	runningConversations.set(conversation.id, {
		abort: abortCompletion.value,
		messages: messages_
	});
	$update(updateConversationListUI);

	if (userText) messages_.push({role: 'user', content: userText, time: Date.now()});

	try {
		let finishReason = await _ApiRequest(conversation, messages_, config.tools, state.additionalBody, abortCompletion, callback, antiSlop);
		const assistantMessage = messages_.at(-1);

		const resumeObj = resumableCompletions[conversation.id];
		if (finishReason !== 'error' || assistantMessage.error !== "network error\n") {
			if (resumeObj) {
				try {
					const result = await jsonFetch(config.endpoint+"/abort/"+resumeObj.id, {
						authorization: config.accessToken,
						method: 'POST'
					});
				} catch (e) {
					showToast("Abort接口调用失败\n"+e, 'error');
				}
				delete resumableCompletions[conversation.id];
			}
		} else {
			if (resumeObj) {
				showToast("连接意外中止\n在"+(RESUME_TIMEOUT/60000)+"分钟内点击重试按钮可以无缝继续对话", 'error');
			}
		}

		let needSave;

		const tone = finish_reason_tone[finishReason];
		const is_ok = tone != null;

		if ('interrupt' !== finishReason && 'loop' !== finishReason) {
			if ('error' !== finishReason) {
				if (!conversation.title) {
					await generateDescription(conversation, messages_);
					needSave = true;
				}
			}

			if ('tool_calls' !== finishReason && config.sound) {
				if (config.sound === "always" || !document.hasFocus())
					is_ok ? complete() : failure();
			}
		}

		if (is_ok && assistantMessage.tool_calls && !config.debug && (!config.maxToolTurns || countAgentTurns(messages_) < config.maxToolTurns)) {
			if (!await runTools(assistantMessage)) {
				// 如果存在可能需要批准的工具调用
				finishReason = 'interrupt';
			}
			needSave = true;
		}

		setStatus(finish_reason_names[finishReason], tone ?? 'error');

		if (needSave) {
			await updateConversation(conversation, unconscious(messages_), true);
		}

		if (selectedConversation.id !== conversation.id) {
			finishReason = 'interrupt'; // 如果不在前台就不自动执行
			showToast("对话 "+conversation.title+"(#"+conversation.id+") 已完成！", "ok");
		}

		return finishReason;
	} finally {
		runningConversations.delete(conversation.id);
		$update(updateConversationListUI);
		abortCompletion.value = null;
	}
}

export const MD_APPEND = 2, MD_END = 3;

function scrollToBottom() {
	requestAnimationFrame(() => {
		const {scroller} = Shared;
		scroller.vl.scrollTo(scroller.scrollHeight);
		lastScrollDirection.value = false;
	});
}

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[] | import("unconscious").Reactive<AiChat.Message[]>} messages
 * @param {boolean=} allowTool
 * @param {Record<string, any>=} additionalBody
 * @param {AbortController} abortCompletion
 * @param {function(type?: number, content?: any): void=} onProgress - null: refresh, T=Think, C=Content, E=End
 * @param {AntiSlop=} antiSlop_
 * @return {Promise<false | string>}
 */
async function _ApiRequest(conversation, messages, allowTool, additionalBody, abortCompletion, onProgress, antiSlop_) {
	let {
		/** @type {string} */
		url,
		/**
		 * @type {{headers: {Authorization: string, "Content-Type": string}, body: string | ReadableStream}}
		 */
		data,
		/** @type {AiChat.AssistantMessage} */
		assistantMessage, initialAssistantMessage,
		/** @type {string | Error} */
		error,
		/** @type {AntiSlop} */
		antiSlop
	} = await composeMessages(conversation, messages, allowTool, additionalBody, antiSlop_).catch(error => {
		return {error};
	});

	if (abortCompletion.signal.aborted) return false;

	if (assistantMessage) {
		delete assistantMessage.error;
		delete assistantMessage.finish_reason;
		onProgress?.();
	} else {
		messages.push(assistantMessage = {
			role: 'assistant',
			content: '',
			model: config.model,
			id: -1
		});
	}

	if (config.debugRequest && !error) {
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
		setStatus('错误', 'error');

		assistantMessage.error = error;
		assistantMessage.finish_reason = 'error';
		return false;
	}

	let finishReason;
	const startTime = Date.now();
	/** @type {Partial<AiChat.BillingLog>} */
	const billingLog = { time: startTime, preset_id: config.name };

	let genImages = [];

	let manualCoTCloseTag;
	{
		let thinkState;
		if ((thinkState = assistantMessage.think)) {
			thinkState.start = startTime;
			assistantMessage.think = $state(thinkState);
		}
	}

	setStatus('请求中');

	// Request
	try {
		let resumeObj;
		await streamFetch(url, {
			...data,
			authorization: config.accessToken,
			signal: abortCompletion.signal
		}, json => {
			if (json.timings) {
				const {predicted_per_second, predicted_n} = json.timings;

				if (json.prompt_progress) {
					const {processed, total} = json.prompt_progress;

					setStatus("预填充: "+(processed / total * 100).toFixed(2)+"%");
					//assistantMessage[PROMPT_PROGRESS] = processed / total;
					//onProgress?.();
					return;
				}
				setStatus("生成中, "+predicted_n+" Tokens, "+predicted_per_second.toFixed(2)+"TPS");
			}

			billingLog.latency = Date.now() - startTime;
			if (!billingLog.request_id) {
				setStatus('生成中');

				assistantMessage.time = Date.now();
				assistantMessage.model = json.model;
				onProgress?.();

				billingLog.request_id = json.id;
				billingLog.model = json.model;
				billingLog.ttft = billingLog.latency;

				if (json.resumable) {
					resumeObj = resumableCompletions[conversation.id] = { id: json.id };
				}
			}
			if (resumeObj) resumeObj.time = Date.now();

			/**
			 * @type {OpenAI.ChatChoice | OpenAI.TextChoice}
			 */
			const chunk = json.choices[0];
			if (config.debug) console.log("SSE response", chunk);

			if (!finishReason) finishReason = chunk?.finish_reason;
			if (finishReason) {getStats(json, billingLog);}

			let text;
			let reasoning_text;
			let reasoning_format  = 'r';

			if (antiSlop?.sample(chunk, assistantMessage)) {
				throw finishReason = "loop";
			}

			if (config.mode === 'chat') {
				const {delta} = chunk;
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
						delete call.index;
						if (!call.id) {
							const last = toolCalls[toolCalls.length-1];
							if (last) {
								applyDelta(unconscious(last), call);
								$update(last);
								continue;
							}
						}
						toolCalls.push($state(call));
						hasNewToolCalls = true;
					}
					if (hasNewToolCalls) onProgress?.(MD_END);
				}
			} else {
				text = chunk.text;
				if (!text) return;
			}

			let content = assistantMessage.content + (text || "");
			if (config.reasoning === false && !manualCoTCloseTag && (manualCoTCloseTag = /^\s*<(thinking|think|thought|reasoning)>/i.exec(content))) {
				reasoning_text = content.substring(manualCoTCloseTag[0].length);
				manualCoTCloseTag = manualCoTCloseTag[1];
				reasoning_format = "m"+manualCoTCloseTag;
				manualCoTCloseTag = "</"+manualCoTCloseTag+">\n";

				let pos = content.indexOf(manualCoTCloseTag);
				if (pos < 0) {
					content = "";
				} else {
					reasoning_text = reasoning_text.substring(0, pos);
					content = content.substring(pos + manualCoTCloseTag.length);
				}
			}

			const thinkState = assistantMessage.think;

			continueThinking:
			if (reasoning_text != null) {
				if (!thinkState) {
					assistantMessage.think = $state({ start: Date.now(), duration: 0, index: 0, content: reasoning_text, format: reasoning_format });
				} else {
					thinkState.content += reasoning_text;
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
							thinkState.content = thinkContent.substring(0, nextIndex);
							content = thinkContent.substring(nextIndex + manualCoTCloseTag.length);
							break;
						}

						index = nextIndex + 1;
					}
				}

				thinkState.duration += Date.now() - thinkState.start;
				delete thinkState.start;
				delete thinkState.index;
				assistantMessage.think = { ... thinkState };
			}

			assistantMessage.content = content;
			if (!assistantMessage.tool_calls) onProgress?.(MD_APPEND, assistantMessage);
		});
	} catch (err) {
		if (err.name === 'AbortError') {
			setStatus('已取消');
			finishReason = "interrupt";
		} else {
			finishReason = 'error';
			abortCompletion.abort();
			if (err !== "loop") {
				// 即便服务端Session过期了，也不要清除已经生成的内容
				if (typeof err === 'string' && initialAssistantMessage) {
					assistantMessage = messages[messages.length-1] = initialAssistantMessage;
				}

				if (config.sound) failure();
				setStatus('错误', 'error');
				console.error(err);
				assistantMessage.error = err.message === "Failed to fetch" ? "API连接失败\n请检查API地址或稍后重试" : prettyError(err);
			}
		}

		return finishReason;
	} finally {
		streamResponseCompleted(assistantMessage, genImages);

		if (!finishReason) {
			finishReason = 'error';
			assistantMessage.error = "network error\n";
		}
		assistantMessage.finish_reason = finishReason;
		billingLog.finish_reason = finishReason;

		onProgress?.(MD_END);

		const has_resp = billingLog.request_id;
		if (finishReason !== 'loop' && conversation.id) {
			// wait for database update (billingLog requires message id), this should be fast
			if (has_resp) {
				await updateConversation(conversation, unconscious(messages));
				billingLog.message_id = assistantMessage.id;
			}
		} else {
			billingLog.message_id = "T_"+Date.now();
		}
		if (has_resp) {
			await appendBillingLog(billingLog);
		}
	}

	return finishReason;
}

/**
 * @return {number}
 */
function countAgentTurns(messages) {
	const arr = messages.value;
	let turns = 0;
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i].finish_reason !== "tool_calls") {
			break;
		}
		turns++;
	}
	return turns;
}

function streamResponseCompleted(assistantMessage, genImages) {
	delete assistantMessage.id;
	if (assistantMessage.reasoning_details) {
		let hasText;
		[assistantMessage.reasoning_details, hasText] = mergeReasoningDetails(assistantMessage.reasoning_details);
		if (hasText) delete assistantMessage.think?.content;
	}
	if (assistantMessage.tool_calls) assistantMessage.tool_calls = assistantMessage.tool_calls.map(unconscious);

	let think;
	if (isReactive(think = assistantMessage.think)) {
		think.duration += Date.now() - think.start;
		delete think.start;

		assistantMessage.think = {...think};
	}

	if (genImages?.length) {
		assistantMessage.content = [
			{
				type: "text",
				text: assistantMessage.content
			},
			...genImages
		]
	}
}

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]} messages
 * @return {Promise<void>}
 */
function generateDescription(conversation, messages) {
	setStatus('生成标题');

	let s1 = getTextContent(messages[0]).substring(0, 512);
	let s2 = getTextContent(messages[1]).substring(0, 512);

	function generateFallbackTitle() {
		const i = s1.indexOf("\n");
		return i >= 0 && i < 30 ? s1.substring(0, i) : s1.substring(0, Math.min(s1.length, 30));
	}

	if (true !== config.generateTitle) {
		return Promise.resolve(conversation.title = generateFallbackTitle());
	}

	let body = {
		model: config.titleModel,
		messages: [{
			role: "system",
			content: `基于以下用户-LLM对话内容，生成一个**20字以内**的中文标题，用于对话前端展示。标题需简洁、吸引人、概括核心主题。

要求：
- 标题长度：严格≤20字。
- 风格：中性、专业，避免剧透或偏见。
- 示例：如果对话是“教我做蛋糕”，标题可为“蛋糕制作教程/指南”。`
		}, {
			role: "user",
			content: "对话摘要：\n用户:\n" + s1 + "\nLLM:\n" + s2
		}],
		max_tokens: 30,
		temperature: 0.7,
		stop: ["\n"],
		reasoning: {enabled: false},
		stream: false
	};

	return jsonFetch(config.endpoint+'/chat/completions', {
		authorization: config.accessToken,
		body: JSON.stringify(body)
	}).then(json => {
		if (json.choices?.[0].finish_reason !== "stop") throw json;
		return json.choices?.[0].message?.content;
	}).catch(err => {
		console.error(err);
		showToast("标题生成失败\n"+prettyError(err), 'error');
	}).then(text => {
		conversation.title = text || generateFallbackTitle();
	});
}

const DISABLE_ALL = /*#__PURE__*/ new Set(["*"]);

export class APIRequest {
	/** @type {AbortController} */
	abort = null;

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
			...state.additionalBody,
			...body
		};
	}

	/**
	 *
	 * @param {AiChat.Message | AiChat.Message[] | string} last_message
	 * @param {function(type?: number, content?: AiChat.AssistantMessage): void=} onProgress
	 * @return {Promise<AiChat.AssistantMessage>}
	 */
	async call(last_message, onProgress) {
		if (this.abort) throw "Already generating";
		this.abort = new AbortController();

		try {
			const messages = isReactive(this.messages) ? this.messages : [...this.messages];
			if (typeof last_message === "string") messages.push({role: 'user', content: userText, time: Date.now()});
			else if (Array.isArray(last_message)) messages.push(...last_message);
			else if (last_message) messages.push(last_message);

			const result = await _ApiRequest(this.conversation, messages, this.conversation.allowedTools.size, this.body, this.abort, onProgress);

			if (result !== "stop")
				throw messages.at(-1).error || "调用失败:"+result;

			return messages.at(-1);
		} finally {
			this.abort = null;
		}
	}

	async interrupt() {
		if (this.abort) this.abort.abort();
	}
}