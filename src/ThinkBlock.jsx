import {$computed, isReactive, unconscious} from "unconscious";
import './ThinkBlock.css';
import {markdown} from "./markdown-stream.js";

/**
 * 合并连续的 reasoning.text 片段
 * @param {OpenAI.ReasoningDetail[]} details
 * @returns {OpenAI.ReasoningDetail[]}
 */
export function mergeReasoningDetails(details) {
	if (details.length === 0) return details;

	const result = [];
	let currentGroup = null;

	for (const item of details) {
		if (item.type === "reasoning.text") {
			// 如果当前有合并组，且格式相同，则追加文本
			if (currentGroup && item.format === currentGroup.format) {
				currentGroup.text += item.text;
			} else {
				// 需要复制吗？？
				currentGroup = { ...item };
				result.push(currentGroup);
			}
		} else {
			result.push(item);
		}
	}

	return result;
}

/**
 * 获取思考文本
 * @param {OpenAI.ReasoningDetail[]} details
 * @returns {string}
 */
function getReasoningTextFromDetails(details) {
	let str = "";

	for (const item of details) {
		if (item.type === "reasoning.text") {
			str += item.text;
		} else if (item.type === "reasoning.summary") {
			str += item.summary;
		}
	}

	return str;
}

/**
 *
 * @param {AiChat.AssistantMessage} think
 * @return {JSX.Element|null}
 * @constructor
 */
export function ThinkBlock({message}) {
	const think = message.think;
	if (!think) return null;

	const durationSec = $computed(() => Math.max(0, Math.round(unconscious(think.duration) / 1000)));

	let content;
	const renderContentAtFirstOpen = () => {
		if (!isReactive(think)) {
			let thinking = think.content;
			if (!thinking) {
				if (!message.reasoning_details) return;
				thinking = getReasoningTextFromDetails(message.reasoning_details);
			}
			content.innerHTML = markdown.render(unconscious(thinking));
		}
	}

	return (
		<details className={'think'+(isReactive(think)?" thinking":"")}>
			<summary title='思考过程' onClick.once={renderContentAtFirstOpen}>
				<span>&nbsp;⏱ 已思考 {durationSec} 秒</span>
				<span className="chevron" aria-hidden>▾</span>
			</summary>
			<div ref={content} className="think-content"></div>
		</details>
	);
}