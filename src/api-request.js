// API request
import {markdownStreamParser} from "./markdown-stream.js";
import {Elements, getTextContent, prettyError, readSSEStream, throttle} from "./utils.js";
import {config, messages, selectedConversation, state} from "./states.js";
import {toolImpl, tools} from "./tools.js";
import {forceRenderMessage} from "./MessageList.jsx";
import {$update} from "unconscious";

function setStatus(text, tone = '') {
	Elements.statusBadge.textContent = text;
	Elements.statusBadge.className = 'badge ' + tone;
}

/**
 *
 * @type {null | AbortController}
 */
export let abortCompletion;

/**
 *
 * @param {OpenAI.Message[]} msg
 * @param {boolean} useTools
 * @return {Promise<Response>}
 */
function requestProvider(msg, useTools) {
	// Prepare request body
	const headers = {
		//'HTTP-Referer': '<YOUR_SITE_URL>',
		'X-Title': 'Fast-AI-Chat',
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${config.accessToken}`
	};
	let path = '/chat/completions';
	let body = {
		model: config.model,
		messages: msg,
		stream: true
	};
	if (config.mode === 'completion') {
		path = '/completions';
		// Build a single prompt from conversation (with roles)
		const promptText = state.completionTemplate(msg);
		body = {
			model: config.model,
			prompt: promptText,
			stream: true
		};
	}
	if (useTools) body.tools = tools;
	if (config.temperature !== 1) body.temperature = config.temperature;
	if (config.maxTokens) body.max_tokens = config.maxTokens;
	if (config.stop) {
		const stops = (config.stop + '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);
		if (stops.length) body.stop = stops;
	}
	const shouldThink = config.reasoning && config.think;
	body.reasoning = {enabled: !!shouldThink};
	if (shouldThink) {
		if (config.reasoning === "minimal") {
			body.reasoning.max_tokens = 1024;
		} else {
			body.reasoning.effort = config.reasoning;
		}
	}
	if (config.enforceParam) {
		body.provider = {require_parameters: true};
	}

	const url = config.endpoint.replace(/\/+$/, '') + path;
	return fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: abortCompletion.signal
	});
}

/**
 *
 * @param {string | OpenAI.ContentPart[]} userText
 * @return {Promise<void>}
 */
export async function sendMessage(userText) {
	if (abortCompletion) throw "streaming";
	abortCompletion = new AbortController();

	let md = markdownStreamParser();
	const updateAssistantMessage = throttle(() => {
		if (md) {
			const last = Elements.messages.lastElementChild?.querySelector('.content');
			if (last) md.render(llmResponse.content, last);

			const scroller = Elements.scroller;
			if (scroller.scrollHeight - scroller.scrollTop - scroller.offsetHeight < 150) {
				scroller.scrollTop = scroller.scrollHeight;
			}
		}
	}, 50);

	// Compose messages (include system prompt only once at the beginning)
	const msg = [];

	if (messages[0]?.role !== 'system' && config.systemPrompt?.trim()) {
		msg.push({role: 'system', content: config.systemPrompt.trim()});
	}

	let useTools = config.tools;

	/**
	 * @type {AiChat.AssistantMessage}
	 */
	let llmResponse;
	if (userText) {
		messages.push({role: 'user', content: userText, time: Date.now()});
	} else {
		// continue mode
		llmResponse = messages[messages.length - 1];
		if (llmResponse.role !== 'assistant') llmResponse = null;
	}
	for (let m of messages) {
		const req_msg = {role: m.role, content: m.content};
		msg.push(req_msg);
		if (m.tool_calls) {
			req_msg.tool_calls = m.tool_calls;
			useTools = true;
		}
		if (m.tool_call_id) req_msg.tool_call_id = m.tool_call_id;
		if ((m.think||m.reasoning_details) && config.keepReasoning) {
			if (m.reasoning_details) req_msg.reasoning_details = m.reasoning_details;
			// fallback
			else req_msg.content = m.think.content + req_msg.content;
		}
	}

	if (llmResponse) {
		delete llmResponse.error;
		delete llmResponse.finish_reason;

		if (llmResponse.tool_calls) {
			for (const call of llmResponse.tool_calls) {
				const tool_data = {
					role: "tool",
					tool_call_id: call.id
				};

				if (call.type === "function") {
					const fn = toolImpl[call.function.name];
					try {
						let result = fn(call.function.arguments ? JSON.parse(call.function.arguments) : null);
						if (result instanceof Promise) result = await result;
						if (result === undefined) result = { result: "Success" };
						tool_data.content = JSON.stringify(result);
					} catch (e) {
						console.error(e);
						tool_data.error = JSON.stringify({
							error: e.name,
							detail: prettyError(e)
						});
					}
				} else {
					tool_data.content = "Unsupported tool type";
				}

				msg.push({
					role: "tool",
					tool_call_id: call.id,
					content: tool_data.error ?? tool_data.content,
				});
				messages.push(tool_data);
			}

			llmResponse = null;
		}
	}

	if (!llmResponse) {
		messages.push(llmResponse = {role: 'assistant', content: '', model: config.model, time: Date.now()});
	} else {
		md.skip(llmResponse.content);
		$update(messages);
	}

	setStatus('请求中');

	// Request
	let finishReason;
	let genImages = [];
	try {
		const resp = await requestProvider(msg, useTools);

		if (!resp.ok) {
			let je = await resp.text();
			try {
				je = JSON.parse(je);
			} catch {}
			let errText = prettyError(je);
			throw new Error(`HTTP ${resp.status}: ${errText}`);
		}

		if (llmResponse.think?.start) {
			llmResponse.think.start = Date.now();
		}

		setStatus('生成中');
		let isReasoning = false;
		await readSSEStream(resp, json => {
			if (config.debug) console.log("SSE response", json);

			if (json.usage) {
				let {completion_tokens, prompt_tokens} = json.usage;
				const reasoning_tokens = json.usage.completion_tokens_details?.reasoning_tokens;

				let usage = prompt_tokens + ' => ' + completion_tokens;
				if (reasoning_tokens) usage += ` (${reasoning_tokens} reasoning)`;

				llmResponse.usage = usage;
				return;
			}

			let text;
			if (config.mode === 'chat') {
				const chunk = json.choices[0].delta;
				if (!chunk) return;

				finishReason = json.choices[0].finish_reason;
				if (chunk.role) llmResponse.role = chunk.role;
				text = chunk.content;

				if (chunk.images) genImages.push(...chunk.images);

				if (chunk.reasoning) {
					text = chunk.reasoning + text;
					if (!isReasoning) {
						isReasoning = true;
						text = "<think>\n" + text;
					}
				} else if (isReasoning) {
					isReasoning = false;
					if (!finishReason || text)
						text = "</think>\n" + text;
				}

				if (chunk.reasoning_details) {
					if (!llmResponse.reasoning_details) {
						llmResponse.reasoning_details = [];
					}

					llmResponse.reasoning_details.push(...chunk.reasoning_details);
				}

				if (chunk.tool_calls) {
					if (!llmResponse.tool_calls) {
						llmResponse.tool_calls = [];
					}

					for (const call of chunk.tool_calls) {
						if (!call.id) continue;
						llmResponse.tool_calls.push(call);
					}
				}
			} else {
				text = json.choices[0].text;
			}

			if (!text) return;

			llmResponse.model = json.model;
			if (!llmResponse.content && !llmResponse.think && text.startsWith("<think>")) {
				llmResponse.think = { start: Date.now() };
			}
			if (llmResponse.think?.start && text.includes("</think>")) {
				const i = text.indexOf("</think>") + 8;
				const before = text.substring(0, i);

				llmResponse.think = {
					duration: Date.now() - llmResponse.think.start,
					content: llmResponse.content + before
				};

				llmResponse.content = "";
				text = text.substring(i);

				forceRenderMessage(llmResponse);
			}

			llmResponse.content += text;
			updateAssistantMessage();
		});

		setStatus('完成：' + finishReason, 'ok');
		await generateDescription(selectedConversation);
	} catch (err) {
		if (err?.name === 'AbortError') {
			setStatus('已取消');
		} else {
			setStatus('错误', 'error');
			console.error(err);
			llmResponse.error = prettyError(err);
		}
	} finally {
		abortCompletion = null;
		if (llmResponse.think?.start) {
			llmResponse.think.duration += Date.now() - llmResponse.think.start;
			llmResponse.think.content += llmResponse.content;
			llmResponse.content = "";
		}
		if (genImages.length) {
			llmResponse.content = [
				{
					type: "text",
					text: llmResponse.content
				},
				...genImages
			]
		}
		llmResponse.finish_reason = finishReason || 'error';
		llmResponse.time = Date.now();
		md = null;
		$update(messages);
	}
}

/**
 *
 * @param {AiChat.Conversation} conversation
 * @return {Promise<string>}
 */
function generateDescription(conversation) {
	if (conversation.title) return Promise.resolve(conversation.title);

	let s1 = getTextContent(messages[0]);
	if (s1.length > 512) s1 = s1.substring(0, 512);
	let s2 = getTextContent(messages[1]);
	if (s2.length > 512) s2 = s2.substring(0, 512);

	function generateFallbackTitle() {
		const i = s1.indexOf("\n");
		return i >= 0 && i < 30 ? s1.substring(0, i) : s1.substring(0, Math.min(s1.length, 30));
	}

	if (!config.generateTitle) {
		conversation.title = generateFallbackTitle();
		return Promise.resolve(conversation.title);
	}

	// Prepare request body
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${config.accessToken}`
	};
	let path = '/chat/completions';
	let body = {
		model: config.titleModel,
		messages: [{
			role: "system",
			content: `基于以下用户-LLM对话内容，生成一个**20字以内**的中文标题，用于对话前端展示。标题需简洁、吸引人、概括核心主题。

要求：
- 标题长度：严格≤20字。
- 风格：中性、专业，避免剧透或偏见。
- 示例：如果对话是“教我做蛋糕”，标题可为“蛋糕制作教程指南”。`
		}, {
			role: "user",
			content: "对话摘要：\n" + s1 + "\n" + s2
		}],
		max_tokens: 30,
		reasoning: {enabled: false},
		provider: {require_parameters: true},
		stream: false
	};

	const url = (config.endpoint).replace(/\/+$/, '') + path;
	return fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	}).then(resp => {
		if (resp.ok) {
			return resp.json();
		}

		return {choices: [{message: {content: ""}, finish_reason: "error"}]};
	}).then(json => {
		let title;

		if (json.choices[0].finish_reason === "stop") {
			title = json.choices[0]?.message?.content;
		}

		if (!title) title = generateFallbackTitle();

		return title;
	}).then(title => {
		return conversation.title = title;
	});
}