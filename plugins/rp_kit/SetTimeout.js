import {$cleanup, debugSymbol, unconscious} from "unconscious";
import {submitUserChatMessage} from "/src/api-request.js";
import {getToolParameters} from "/src/toolset.js";
import {EVENT_BUS, LOCKED, selectedConversation} from "/src/states.js";
import {getImmediateMessages, markMessageDirty} from "/src/database.js";

const TIMEOUT = debugSymbol("TimeoutId");

const finish = async (response, message, conv) => {
	// 最后一个是检测这条对话是不是已经被删除了
	if (null == response.success && !conv[LOCKED] && getImmediateMessages(conv)?.at(-1) === message) {
		if (response[TIMEOUT]) {
			response.content = `timeout: ${response.duration = Date.now() - response.time}ms elapsed`;
			response.success = true;
		}
		markMessageDirty(message);
		submitUserChatMessage(true, conv);
	}
};

/**
 * @type {AiChat.FunctionTool<{
 *     deadline: number,
 * }>}
 */
export const SetTimeout = {
	name: "SetTimeout",
	description:
		"Wait for user message or asynchronous notifications. "
		+ "If a message was received before the deadline, the tool call resolves with 'interrupt: xms elapsed'. "
		+ "Otherwise it resolves with 'timeout'. "
		+ "\n"
		+ "Use for timed interactions (QTE), reminders, or waiting real-time events. "
		+ "\n"
		+ "Note for QTE: account reading / typing latency. The user needs time to read the prompt, think, type, and send. "
		+ "10 seconds is only appropriate for single-key / single-click prompts. ",
	interactive: true,
	parameters: {
		type: "object",
		properties: {
			label: {
				type: "string",
				description: "Short timer name shown to the user.",
				maxLength: 60
			},
			timeout: {
				type: "integer",
				description: "Real-world duration in seconds.",
				minimum: 5,
				maximum: 300
			},
			deadline: {
				type: "string",
				description: "ISO 8601 timestamp. Mutually exclusive with `timeout`.",
				example: "2026-06-01T08:00:00+08:00"
			}
		}
	},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		let str = par.timeout != null ? '等待 '+par.timeout+"s" : "等到 "+new Date(par.deadline).toLocaleString();
		return par.label ? str+`: `+par.label : str;
	},

	script({ timeout, deadline, label }, response, conv, toolName, message)  {
		// 异步消息
		if (response.deadline != null) {
			let reason = '';
			if (!(TIMEOUT in response)) {
				reason = " (by=harness restart)";
			} else {
				clearTimeout(response[TIMEOUT]);
			}

			return `interrupt${reason}: ${Date.now() - response.time}ms elapsed`;
		}

		let ddl;
		if (timeout != null) {
			if (deadline) throw 'Both timeout and deadline are specified';
			ddl = Date.now() + timeout * 1000;
		} else {
			if (!deadline) throw 'Neither timeout or deadline is specified';
			ddl = + new Date(deadline);
			if (isNaN(ddl)) throw 'Invalid Date';
			if (ddl - Date.now() < 10000) throw 'Deadline too close';
		}

		response.time = Date.now();
		response.deadline = ddl;

		if (conv.meta?.owner) {
			return new Promise((resolve) => {
				const cancel = EVENT_BUS.onoff('messageInject', conv_ => {
					if (conv_ === conv) {
						resolve(`interrupt: ${Date.now() - response.time}ms elapsed`);
						clearTimeout(t);
						cancel();
					}
				});

				const t = setTimeout(() => {
					cancel();
					resolve(`timeout: ${Date.now() - response.time}ms elapsed`);
				}, ddl - response.time);
			});
		}

		response[TIMEOUT] = setTimeout(() => finish(response, message, conv), ddl - response.time);
	},
	keyFunc(keys, response, frozen, message) {
		keys.push(frozen);
		// 手动输入
		if (frozen && null == response.content && response.deadline != null) {
			response.success = true;
			response.content = `interrupt: ${response.duration = Date.now() - response.time}ms elapsed`;
			clearTimeout(response[TIMEOUT]);
			markMessageDirty(message);
		}
	},
	renderer(response, has_successor, call, message) {
		if (has_successor || response.deadline == null) return;

		const now = Date.now();
		const start = response.time;
		const deadline = response.deadline;
		const duration = deadline - start;
		const elapsed = now - start;

		const conv = unconscious(selectedConversation);
		const onFinish = () => finish(response, message, conv);

		const timing = `animation-duration:${duration}ms;animation-delay:-${Math.min(elapsed, duration)}ms`;

		const el = (<div className="rp-timer"><div className="pbar" style={timing} /></div>);

		const left = deadline - now;
		if (left > 0) {
			if (null == response[TIMEOUT]) {
				const timer = setTimeout(onFinish, left);
				$cleanup(el, () => {clearTimeout(timer);});
			}
		} else {
			onFinish();
		}

		return el;
	}
}

