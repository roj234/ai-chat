import {$computed, isReactive} from "unconscious";
import './ThinkBlock.css';
import {renderMarkdownToElement} from "../md-wrapper.js";
import {EditWidget} from "./EditWidget.jsx";
import {copyButtonAnimation} from "../utils.js";

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
export function ThinkBlock({message, edit}) {
	const {think} = message;
	if (!think) return null;

	let content;
	const renderContentAtFirstOpen = () => {
		if (!isReactive(think)) {
			let thinking = think.content;
			if (!thinking) {
				if (!message.reasoning_details) return;
				thinking = getReasoningTextFromDetails(message.reasoning_details);
			}
			if (edit) {
				content.replaceWith(<EditWidget value={thinking} onChange={(value) => think.content = value}/>)
			} else {
				renderMarkdownToElement(content, thinking);
			}
		}
	}

	const title = think.title;
	return (
		<details className={'think'} class:thinking={() => !!think.start}>
			<summary title={title || '展开思考过程'} onClick.once={renderContentAtFirstOpen}>
				<span className="chevron ri-play-large-fill"></span>
				{title || $computed(() => {
					let duration = think.duration;
					if (null == duration) return "已完成思考";

					if ("start" in think) duration += Date.now() - think.start;
					return "已思考 " + Math.round(duration / 1000) + " 秒";
				})}
			</summary>
			<div ref={content} className="think-content">
				<button className={"ri-file-copy-line ghost"} title={"复制"} onClick={({target}) => {
					copyButtonAnimation(think.content, target);
				}}></button>
			</div>
		</details>
	);
}