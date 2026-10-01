import {createHash} from 'node:crypto';
import {SSE_PROXY_MODERATION, SSE_REF_CACHE_SIZE} from '../config.js';
import {LRUCache} from '../../common/LRUCache.js';
import {applyDelta, ORIGINAL_ERROR, sseFetch} from '../../common/fetch-utils.js';
import {getProxyAgent} from '../utils/socks5-agent.js';
import {processMessageRefs} from './api-proxy-utils.js';
import {createJsonStream} from "../../common/StreamJsonSerializer.js";
import {encodeRawMsg} from "unconscious/common/msgpack.js";
import {ProxyResumeManager} from "./api-proxy-resume.js";

// ============================================================================
// Module state & limits
// ============================================================================

/**
 *
 * @type {LRUCache<string, LRUCache<string, { prefix: number, id: string }>>}
 */
const sessions = new LRUCache(254, {ttlMode: 'access'});

/**
 * Create an error tagged with the HTTP status the route handler should answer with.
 * @param {string} message
 * @param {number} [status=400]
 * @returns {DOMException & {status: number}}
 */
const bad = (message, status = 400) => Object.assign(new DOMException(message), {status});

/**
 * Normalize a thrown value into an error envelope for `ctx.send` or an SSE error frame.
 * @param {*} e
 * @returns {{error: *}}
 */
function errorObject(e) {
	const message = e.message || String(e);
	try {
		const obj = JSON.parse(message);
		return obj.error ? obj : {error: obj};
	} catch {
		return {error: message};
	}
}

// ============================================================================
// region Request translation (Chat Completions -> Responses)
// ============================================================================

const CACHE_KEYS = ['model', 'instructions', 'tools', 'reasoning'];

/**
 * @param {string | Array<object>} content
 * @param {string} role
 * @returns {string | Array<object>}
 */
function convertContentPart(content, role) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) throw bad(`Unsupported ${role} content`);
	return content.map((part) => {
		if (part.type === 'text' && typeof part.text === 'string')
			return {type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text};
		if (part.type === 'image_url' && role === 'user' && typeof part.image_url?.url === 'string')
			return {
				type: 'input_image',
				image_url: part.image_url.url,
				...(part.image_url.detail ? {detail: part.image_url.detail} : {})
			};
		throw bad(`Unsupported ${role} content part: ${part.type}`);
	});
}

/**
 * @param {OpenAI.Message} m
 * @returns {Array<object>} one or more Responses input items.
 */
function convertMessage(m) {
	if (m.role === 'tool') return [{type: 'function_call_output', call_id: m.tool_call_id, output: m.content}];

	const content = [];

	const details = m.reasoning_details;

	if (details) {
		const chunk = { type: 'reasoning' };
		for (const detail of details) {
			if (detail.format === 'openai-responses-v1') {
				if (detail.type === 'reasoning.encrypted') {
					chunk.encrypted_content = detail.data;
					chunk.id = detail.id;
				}
				if (detail.type === 'reasoning.summary') {
					(chunk.summary ??= []).push({ type: 'summary_text', text: detail.summary });
					chunk.id = detail.id;
				}
				if (detail.type === 'reasoning.text') {
					(chunk.content ??= []).push({ type: 'reason_text', text: detail.text });
					chunk.id = detail.id;
				}
			}
		}
		if (chunk.id) content.push(chunk);
	}

	if (m.content != null)
		content.push({role: m.role, content: convertContentPart(m.content, m.role)});

	if (m.tool_calls) {
		for (const call of m.tool_calls) {
			content.push({
				type: 'function_call', call_id: call.id,
				...call.function
			});
		}
	}

	if (!content.length) throw bad('Empty message');
	return content;
}

const KNOWN_KEYS = ['messages', 'max_completion_tokens', 'max_tokens', 'logprobs', 'reasoning_effort', 'tool_choice', 'response_format'];

/**
 * @param {OpenAI.ChatCompletionRequest} body validated inbound body.
 * @param {OpenAI.Message[]} messages messages after blob-reference expansion.
 * @returns {Object}
 */
function convertRequest(body, messages) {
	if ('n' in body && body.n !== 1) throw bad('n > 1 is not supported');

	let instructions;
	if (messages[0].role === 'system') {
		instructions = messages.shift().content;
	}

	const out = {
		store: false,
		include: ['reasoning.encrypted_content'],
		...body,
		instructions,
		input: messages.map(convertMessage),
	};
	for (const key of KNOWN_KEYS)
		delete out[key];

	const tokens = body.max_completion_tokens ?? body.max_tokens;
	if (tokens) out.max_output_tokens = tokens;

	if (body.logprobs) { out.include.push('message.output_text.logprobs'); out.top_logprobs ??= body.logprobs; }
	if (body.reasoning_effort != null) out.reasoning = {effort: body.reasoning_effort, summary: 'auto'};

	if (body.tools) {
		out.tools = body.tools.map((tool) => {
			if (!tool.function?.name) throw bad('Only function tools supported');
			const fn = tool.function;
			return { type: 'function', ...fn };
		});
	}

	const toolChoice = body.tool_choice;
	if (toolChoice != null) {
		out.tool_choice = typeof toolChoice === 'object' && toolChoice.type === 'function'
			? {type: 'function', name: toolChoice.function?.name}
			: toolChoice;
		if (typeof out.tool_choice === 'object' && !out.tool_choice.name) throw bad('Invalid tool_choice');
	}

	if (body.response_format) {
		const format = body.response_format;
		if (format.type === 'text') out.text = {format: {type: 'text'}};
		else if (format.type === 'json_object') out.text = {format: {type: 'json_object'}};
		else if (format.type === 'json_schema') out.text = {format: {type: 'json_schema', ...format.json_schema}};
		else throw bad('Unsupported response_format');
	}

	return out;
}

// ============================================================================
// endregion
// ============================================================================

/**
 * @param {object} usage
 * @returns {OpenAI.OpenRouter.ResponseUsage | null}
 */
function convertUsage(usage) {
	if (Number.isFinite(usage?.input_tokens)) {
		return {
			completion_tokens: usage.output_tokens,
			total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
			prompt_tokens: usage.input_tokens,
			prompt_tokens_details: usage.input_tokens_details,
			completion_tokens_details: usage.output_tokens_details,
			cost: usage.cost,
			cost_details: usage.cost_details,
		};
	}
}

// ============================================================================
// Route handler
// ============================================================================

/**
 * Stream adapter for `POST /chat/completions` -> OpenAI Responses.
 *
 * @param {AiChatBackend.SSEProxyTarget} target
 * @param {?string} logPath
 * @param {?string} blobDir
 * @param {AiChatBackend.RouteContext} ctx
 * @returns {Promise<void>}
 */
export async function responsesProxyHandler(target, logPath, blobDir, ctx) {
	/** @type {object} */
	let body;
	/** @type {string[]} */
	let newCached;

	try {
		/** @type {OpenAI.ChatCompletionRequest} */
		const origBody = JSON.parse(await ctx.readAsString(20971520));
		if (!origBody || Array.isArray(origBody) || typeof origBody !== 'object') throw bad('Invalid JSON request');
		let messages = origBody.messages;

		if (blobDir) {
			if (!Array.isArray(messages)) throw bad('Missing messages');
			[messages, newCached] = await processMessageRefs(messages, blobDir);
			if (!messages) return ctx.send(409, {error: 'cache_expired', hashes: newCached});
			if (origBody.cache_only) return ctx.send(201, {new_cached: newCached});
		}

		const moderation = SSE_PROXY_MODERATION(target.url, target.authorization, ctx);
		if (moderation && typeof moderation !== 'function') return ctx.send(400, moderation);
		if (moderation) {
			const rejected = await moderation({...origBody, messages});
			if (rejected) return ctx.send(400, rejected);
		}

		body = convertRequest(origBody, messages);
	} catch (e) {
		return ctx.send(e.status || 400, errorObject(e));
	}

	if (target.store != null) body.store = target.store;
	if (body.stream !== true) throw bad("Non-streaming responses API is not supported yet");
	// https://developers.openai.com/api/reference/resources/responses/methods/create#(resource)%20responses%20%3E%20(method)%20create%20%3E%20(params)%200.non_streaming%20%3E%20(param)%20stream_options%20%3E%20(schema)%20%3E%20(property)%20include_obfuscation
	else body.stream_options = { include_obfuscation: false };

	const base = target.url.endsWith('/') ? target.url : target.url + '/';
	const sessionKey = createHash('sha256').update(JSON.stringify([target.url, target.authorization])).digest('base64url');

	const hasher = createHash("sha256");
	const addObject = obj => encodeRawMsg(obj, (data) => hasher.update(data), {sortKeys: true, });

	const cacheMajorKey = {};
	for (const key of CACHE_KEYS) {
		cacheMajorKey[key] = body[key];
	}
	addObject(cacheMajorKey);

	const messages = body.input;
	let best, bestHash;

	if (body.store !== false) {
		const checkpoints = sessions.get(sessionKey) ?? new LRUCache(SSE_REF_CACHE_SIZE);
		sessions.set(sessionKey, checkpoints);

		for (let i = 0; i < messages.length; i++) {
			addObject(messages[i]);

			const hash = hasher.copy().digest('base64url');
			const candidate = checkpoints.get(hash);
			if (candidate != null) {
				bestHash = hash;
				best = candidate;
			}
		}

		if (best) {
			body.previous_response_id = best.id;
			body.input = messages.slice(best.prefix);
		}
	}

	body.input = body.input.flat();

	const pm = new ProxyResumeManager(ctx, body, target.trace && logPath);
	ctx.res.once('close', () => pm.end());

	let indices = new Map(), toolCallIndex = 0;

	const sumDelta = {};
	const completion = Object.assign(pm.completion, {
		object: 'chat.completion.chunk',
		choices: [{index: 0, delta: sumDelta}],
	});

	/**
	 * Write one `chat.completion.chunk` frame.
	 * @param {object} delta delta payload of the single choice.
	 * @param {object} [extra] extra top-level chunk fields (e.g. `usage`).
	 * @returns {void}
	 */
	const send = (delta, extra = {}) => {
		if (!pm.req) {
			extra.resumable = pm.begin(extra.id);
			if (newCached) ctx.res.write(`data: ${JSON.stringify({new_cached: newCached})}\n\n`);
		}

		pm.send(JSON.stringify({ choices: [{index: 0, delta}], ...extra }));

		applyDelta(sumDelta, delta);
		Object.assign(completion, extra);
	};

	try {
		await sseFetch(base+'responses', {
			key: target.authorization,
			agent: getProxyAgent(target.proxy),
			signal: pm.abort.signal,
			headers: {'Content-Type': 'application/json', ...target.headers},
			body: createJsonStream(body)
		}, (event, eventName) => {
			if (eventName === '\0') throw bad('Upstream returned non-stream JSON', 502);

			let extra;
			if (eventName.endsWith('.delta') || eventName === 'response.output_item.done') {
				const resumable = pm.completion.resumable;
				if (null == resumable.ft) {
					resumable.ft = resumable.now = Date.now();
					extra = { resumable };
				}
			}

			switch (eventName) {
				case 'response.created': {
					const response = event.response;
					send({role: 'assistant'}, {
						id: response.id,
						model: response.model,
						created: response.created_at,
						prompt_cache_key: response.prompt_cache_key,
						prompt_cache_retention: response.prompt_cache_retention
					});
				}
				break;
				//case 'response.in_progress': break;

				case 'response.output_item.added': {
					const item = event.item;
					const outputIndex = event.output_index;
					if (item.type === 'function_call') {
						const index = toolCallIndex++;
						indices.set(outputIndex, index);
						send({
							tool_calls: [{
								index, id: item.call_id, type: 'function',
								function: {name: item.name, arguments: ''}
							}]
						});
					} else if (item.type === 'reasoning') {
						indices.set(outputIndex, item.id);
					}
				}
				break;

				case 'response.refusal.delta': send({refusal: event.delta}, extra); break;
				case 'response.output_text.delta':send({content: event.delta}, extra);break;
				case 'response.function_call_arguments.delta':send({tool_calls: [{index: indices.get(event.output_index), function: {arguments: event.delta}}]}, extra);break;
				case 'response.reasoning_text.delta':
					send({
						reasoning_details: [{
							index: 0, // FIXME
							id: indices.get(event.output_index),
							type: 'reasoning.text',
							format: 'openai-responses-v1',
							text: event.delta,
						}]
					}, extra);

					break;
				case 'response.reasoning_summary_text.delta':
					send({
						reasoning_details: [{
							id: indices.get(event.output_index),
							type: 'reasoning.summary',
							format: 'openai-responses-v1',
							summary: event.delta,
						}]
					}, extra);
				break;

				//case 'response.content_part.done': break;

				case 'response.output_item.done': {
					const item = event.item;
					 if (item.type === 'reasoning') {
						 const resumable = pm.completion.resumable;
						 if (null == resumable.re)
							 resumable.re = resumable.now = Date.now();

						 send({
							 reasoning_details: [{
								 id: item.id,
								 type: 'reasoning.encrypted',
								 format: 'openai-responses-v1',
								 data: item.encrypted_content
							 }]
						 }, { resumable });
					}
				}
				break;

				case 'response.failed':
				case 'response.incomplete':
				case 'response.completed': {
					const response = event.response ?? {};

					const error = response.error;
					if (error) throw bad(JSON.stringify(error), 502);

					let finish_reason = sumDelta.tool_calls ? 'tool_calls' : 'stop';
					const details = response.incomplete_details;
					if (details) {
						if (details.reason !== 'max_output_tokens')
							throw bad(JSON.stringify(details), 502);
						finish_reason = 'length';
					}

					const usage = convertUsage(response.usage);
					const extra = { usage, tool_usage: response.tool_usage, };

					ctx.res.write(`data: ${JSON.stringify({ choices: [{index: 0, finish_reason}], ...extra })}\n\n`);

					completion.choices[0].finish_reason = finish_reason;
					Object.assign(completion, extra);
				}
				break;
			}
		});

		if (null == completion.choices[0].finish_reason)
			throw bad('Upstream stream ended without response.completed', 502);

		// ignore refusal delta.
		if ('refusal' in sumDelta || body.store === false) return;

		addObject(convertMessage(sumDelta));
		const checkpoints = sessions.get(sessionKey);
		checkpoints?.set(hasher.digest('base64url'), {
			id: completion.id,
			prefix: messages.length + 1
		});
	} catch (err) {
		let {status = 500, [ORIGINAL_ERROR]: message} = err;

		if (status === 400 || status === 404) {
			// TODO 我没有官方订阅可以测试这个 LoL
			if (['previous_response_not_found', 'response_not_found'].includes(message?.error?.code)) {
				checkpoints.delete(bestHash);
				pm.end(true);
				return responsesProxyHandler(target, logPath, blobDir, ctx);
			}
		}

		pm.onError(err);
	} finally {
		pm.end(true);
	}
}
