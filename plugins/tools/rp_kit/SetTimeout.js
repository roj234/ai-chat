import {$state} from "unconscious";
import {submitUserChatMessage} from "/src/api-request.js";
import {getToolParameters} from "/src/skills.js";

/**
 * @type {AiChat.FunctionTool<{
 *     deadline: number,
 * }>}
 */
export const SetTimeout = {
	name: "SetTimeout",
	description:
		"Create a real-time countdown timer and receive a message when it finishes. "
		+ "If the user replies before the deadline, the tool call resolves with result: 'userInput'. "
		+ "If the user fails to respond in time, the tool call resolves with result: 'timeout'. "
		+ "\n"
		+ "IMPORTANT — account reading / typing latency. The user needs time to read the prompt, think, type, and send. "
		+ "10 seconds is only appropriate for single-key / single-click prompts. "
		+ "\n"
		+ "Use for timed interactions, reminders inside a scenario, or delayed real-time events. "
		+ "Use only when real elapsed time matters, not for fictional time skips or ordinary narrative pacing.",
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
		},
		required: ["label", "timeout"],
	},

	script({ timeout, label }, response)  {
		response.deadline = Date.now() + timeout * 1000;
		// return undefined
	},
	keyFunc(keys, response, frozen) {
		keys.push(frozen);
		if (frozen && !response.success) {
			response.success = true;
			response.content = 'userInput';
		}
	},
	renderer(response, has_successor, call) {
		if (has_successor) return;

		const {label, timeout} = getToolParameters(response, call);
		const deadline = response.deadline;

		let start = Date.now();
		const percent = $state(start < deadline ? 0 : 100);

		const onFinish = () => {
			if (!response.success) {
				response.success = true;
				response.content = `timeout`;
				submitUserChatMessage();
			}
		};

		const update = () => {
			if (!el.isConnected) return;

			let remain = (deadline - Date.now()) / 1000;
			let p = Math.max(0, 100 - (remain / timeout) * 100);
			percent.value = p;

			if (p < 100) requestAnimationFrame(update);
			else onFinish();
		};
		if (start < deadline) requestAnimationFrame(update);
		else onFinish();

		const el = (
			<div className="rp-timer">
				<span>⏳ {label} ({timeout}s)</span>
				<div className="progress">
					<div
						className="bar"
						class:ended={() => percent.value >= 100}
						style:width={() => `${percent.value}%`}
					/>
				</div>
			</div>
		);

		return el;
	},
}

