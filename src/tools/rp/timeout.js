import {$state} from "unconscious";
import {abortCompletion} from "../../api-request.js";
import {messages} from "../../states.js";

/**
 * @type {AiChat.FunctionTool}
 */
export const timeout = {
	name: "set_timeout",
	description: "创建一个计时器，在倒计时结束后收到消息。",
	parameters: {
		type: "object",
		properties: {
			label: { type: "string", description: "计时器的名称" },
			seconds: { type: "integer", description: "以秒为单位的现实时间" },
			hidden: { type: "boolean", description: "对玩家隐藏计时器", default: false },
		},
		required: ["label", "seconds"],
	},

	script({ seconds, label, hidden = false }, response)  {
		response.data = {
			label,
			seconds,
			deadline: Date.now() + seconds * 1000,
			hidden,
		};
	},
	keyFunc(keys, {data}) {
		if (!data.notified && Date.now() >= data.deadline && abortCompletion.value == null) {
			data.notified = true;

			messages.push({
				role: "user",
				time: data.deadline,
				content: `计时器 "${data.label}" 已到期`
			});
		}
	},
	renderer({data}) {
		const { label, seconds, deadline, hidden } = data;
		if (hidden) return;

		let start = Date.now();
		const percent = $state(start < deadline ? 0 : 100);

		function update() {
			let remain = (deadline - Date.now()) / 1000;
			let p = Math.max(0, 100 - (remain / seconds) * 100);
			percent.value = p;
			if (p < 100) requestAnimationFrame(update);
		}
		if (start < deadline) requestAnimationFrame(update);

		return (
			<div className="timer-box">
				<span>⏳ {label} ({seconds}s)</span>
				<div className="rp-progress-container">
					<div
						className="rp-progress-bar"
						class:ended={() => percent.value >= 100}
						style:width={() => `${percent.value}%`}
					/>
				</div>
			</div>
		);
	},
}

