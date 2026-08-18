import {
	abortCompletion,
	config,
	inputText,
	messages,
	selectedConversation,
	updateConversationUI,
	updateMessageUI
} from "../states.js";
import {$computed, $state, $watch, $watchWithCleanup, unconscious} from "unconscious";
import {TOOL_NAME, toolScriptRegistry} from "../toolset.js";

import "./ContextUsage.css";
import {getContextStrokeColor} from "./contextColor.js";
import {DI} from "../hooks.js";

const x = ["发送", "中止", "继续", "重试", "执行工具"];
const y = ["ri-send-plane-fill", "ri-square-fill", "ri-play-large-fill", "ri-loop-right-line", "ri-function-ai-line"/* ri-check-double-line */];
const button_state_map = {
	//stop: 0,
	interrupt: 2,
	length: 2,
	error: 3,
	tool_calls: 4
};

export function ContextRing(sendBtn) {
	const SIZE = 30 + 4 + 4;
	const RADIUS = 15 + 2;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 502.65
	let bar, tooltipDiv;
	const usageText = $state("");
	const root = <div className="ring">
		{sendBtn}
		<span className={"tooltip"} ref={tooltipDiv}>上下文: {usageText}</span>
		<svg width={SIZE} height={SIZE}>
			<defs>
				<linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="#00c6ff"/>
					<stop offset="100%" stop-color="#0072ff"/>
				</linearGradient>
			</defs>
			<circle className="track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>
			<circle className="bar" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} ref={bar}/>
		</svg>
	</div>;

	bar.style.strokeDasharray = CIRCUMFERENCE;
	const mc = $computed(() => config.maxContext);
	const cu = $computed(() => selectedConversation.contextUsage);
	$watchWithCleanup([updateConversationUI, cu, mc], () => {
		let pct = selectedConversation.contextUsage / config.maxContext;
		tooltipDiv.style.display = isNaN(pct) ? 'none' : '';
		if (pct > 1) pct = 1;

		bar.style.strokeDashoffset = CIRCUMFERENCE * (1 - (pct || 0));
		bar.style.stroke = getContextStrokeColor(pct);
		usageText.value = (pct * 100).toFixed(2) + "%\n" + `${selectedConversation.contextUsage} / ${config.maxContext}`;
	});
	return root;
}

/**
 * @param {import("unconscious").Reactive<OpenAI.ContentPart[]>} attachments
 * @param {function(Event): void} onSend
 * @return {JSX.Element}
 */
export const createSendButton = (attachments, onSend) => {
	const sendBtn = DI.sendButton = <button onClick={onSend} />;

	/** @param {number} state */
	const setIcon = state => {
		sendBtn.className = y[state]+" btn primary";
		sendBtn.title = x[state];
	};

	const checkAuxActions = () => {
		const value = unconscious(abortCompletion);
		setIcon(value ? 1 : 0);
		if (value) return true;

		const last = messages.at(-1);
		if (!last || selectedConversation.noAI) return false;

		if (selectedConversation.resumeId) {
			setIcon(2);
			return true;
		}

		if (last.role === 'assistant') {
			let state = button_state_map[last.finish_reason];
			if (state == null) {
				// 手动构造消息
				if (last.tool_calls?.length) {
					state = 4;
				}
			}
			if (!state) return false;
			setIcon(state);

			if (state === 4) {
				for (let response of last.tool_responses) {
					if (!response) return 0;
					if (toolScriptRegistry[response[TOOL_NAME]]?.interactive && !response.content)
						return response.content == null ? null : false;
				}
			}

			return true;
		}

		return last.role === "user";
	};

	$watch([messages, abortCompletion, attachments, inputText, updateMessageUI], () => {
		const action = checkAuxActions();
		sendBtn.disabled = action === null || (!action && !inputText.trim() && !attachments.length);
	});
	return ContextRing(sendBtn);
};