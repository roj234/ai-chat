import {abortCompletion, inputText, messages, selectedConversation} from "../states.js";
import {$watch, unconscious} from "unconscious";

const x = ["发送", "中止", "继续", "重试", "执行工具"];
const y = ["ri-send-plane-fill", "ri-square-fill", "ri-play-large-fill", "ri-loop-right-line", "ri-function-ai-line"/* ri-check-double-line */];
const button_state_map = {
	//stop: 0,
	interrupt: 2,
	length: 2,
	error: 3,
	tool_calls: 4
};

/**
 * @param {import("unconscious").Reactive<OpenAI.ContentPart[]>} attachments
 * @param {function(Event): void} onSend
 * @return {JSX.Element}
 */
export const createSendButton = (attachments, onSend) => {
	const sendBtn = <button onClick={onSend} />;

	/** @param {number} state */
	const setSendBtnIcon = state => {
		sendBtn.className = y[state]+" btn primary";
		sendBtn.title = x[state];
	};

	const hasOtherSendBtnAction = () => {
		const value = unconscious(abortCompletion);
		setSendBtnIcon(value ? 1 : 0);
		if (value) return true;

		const last = messages.at(-1);
		if (!last || selectedConversation.noAI) return false;

		if (last.role === 'assistant') {
			let state = button_state_map[last.finish_reason];
			if (state == null) {
				// 手动构造消息
				if (last.tool_calls?.length) {
					state = 4;
				}
			}
			if (!state) return false;
			setSendBtnIcon(state);

			if (state === 4) {
				for (let response of last.tool_responses) {
					if (null == response.content) return false;
				}
			}

			return true;
		}

		return last.role === "user";
	};

	$watch([messages, abortCompletion, attachments, inputText], () => {
		sendBtn.disabled = !hasOtherSendBtnAction() && !inputText.trim() && !attachments.length;
	});

	return sendBtn;
};