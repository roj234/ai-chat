import {$state, $update} from "unconscious";
import {submitUserChatMessage} from "/src/api-request.js";
import {getToolParameters} from "/src/toolset.js";
import {LOCKED, messages, selectedConversation} from "/src/states.js";
import {markMessageDirty} from "/src/database.js";

/**
 * @type {AiChat.FunctionTool<{
 *     deadline: number,
 * }>}
 */
export const SetTimeout = {
	name: "SetTimeout",
	description:
		"Create a real-time timer and receive a message when it finishes. "
		+ "If the user replies before the deadline, the tool call resolves with result: 'userInput'. "
		+ "Otherwise the tool call resolves with result: 'timeout'. "
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
				minimum: 10,
				maximum: 300
			},
			deadline: {
				type: "string",
				description: "ISO 8601 timestamp. Mutually exclusive with `timeout`.",
				example: "2026-06-01T08:00:00+08:00"
			}
		},
		required: ["label"],
	},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		return `等待 ${par.timeout}s: ` + par.label;
	},

	script({ timeout, deadline, label }, response, conv)  {
		let ddl;
		if (timeout != null) {
			if (deadline) throw 'Both timeout and deadline are specified';
			ddl = Date.now() + timeout * 1000;
		} else {
			if (!deadline) throw 'Neither timeout or deadline is specified';
			ddl = new Date(deadline);
			if (isNaN(ddl)) throw 'Invalid Date';
			if (ddl - Date.now() < 10000) throw 'Deadline too close';
		}

		response.time = Date.now();
		response.deadline = ddl;

		if (conv.owner) {
			return new Promise((resolve) => {
				setTimeout(() => resolve("timeout"), ddl - response.time);
			});
		}

		return ''
	},
	keyFunc(keys, response, frozen, message) {
		keys.push(frozen);
		if (frozen && "" === response.content) {
			const deadline = response.deadline;
			response.content = `userInput (${deadline - Date.now()}ms remaining)`;
			markMessageDirty(message);
		}
	},
	renderer(response, has_successor, call, message) {
		if (has_successor) return;

		const args = getToolParameters(response, call);
		const interactive = !selectedConversation.owner;
		if (interactive && null == response.success) {
			response.success = true;
			response.content = SetTimeout.script(args, response);
			markMessageDirty(message);
			$update(messages); // save
		} else if (response.deadline == null) return;

		let start = response.time || Date.now();
		const deadline = response.deadline;
		const timeout = deadline - start;

		const percent = $state(start < deadline ? 0 : 100);

		const onFinish = () => {
			if (!response.content && !selectedConversation[LOCKED]) {
				response.content = `timeout`;
				response.success = true;
				markMessageDirty(message);
				submitUserChatMessage(true);
			}
		};

		const update = () => {
			if (!el.isConnected) return;

			let remain = deadline - Date.now();
			let p = Math.max(0, 100 - (remain / timeout) * 100);
			percent.value = p;

			if (p < 100) requestAnimationFrame(update);
			else onFinish();
		};
		if (start < deadline) requestAnimationFrame(update);
		else onFinish();

		const el = (
			<div className="rp-timer">
				<div className="progress">
					<div
						className="pbar"
						class:ended={() => percent.value >= 100}
						style:width={() => `${percent.value}%`}
					/>
				</div>
			</div>
		);

		return el;
	},
}

