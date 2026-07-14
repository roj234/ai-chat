import {$computed, isReactive} from "unconscious";
import './ThinkBlock.css';
import {renderMarkdownToElement} from "../markdown/markdown.js";
import {EditWidget} from "./EditWidget.jsx";
import {copyButtonAnimation} from "../utils/utils.js";
import {config} from "../states.js";

/**
 * @param {OpenAI.ReasoningDetail[]} details
 * @returns {string}
 */
const extractReasoningTextFromDetails = details => {
	let str = "";

	for (const item of details) {
		if (item.type === "reasoning.text") {
			str += item.text;
		} else if (item.type === "reasoning.summary") {
			str += item.summary+"\n\n";
		}
	}

	return str.trim();
};

const reasoningFormatNames = {
	r: "reason",
	rc: "reasoning_content",
	mthink: "纯文本<think>",
	mthinking: "纯文本<thinking>",
};

/**
 *
 * @param {AiChat.AssistantMessage} think
 * @return {JSX.Element|null}
 */
export function ThinkBlock({message, edit}) {
	const {think} = message;
	if (!think) return null;

	let container;
	const renderContentAtFirstOpen = () => {
		if (!isReactive(think)) {
			let {content, format} = think;
			if (null == content) {
				if (!message.reasoning_details) return;
				content = extractReasoningTextFromDetails(message.reasoning_details);
			}
			if (edit) {
				const arr = [];
				if (format != null) {
					arr.push(<div style={"font-size:14px"}>思维链格式&nbsp;&nbsp;<select onChange={({target}) => {
						think.format = target.selectedOptions[0].value;
					}}>
						{Object.entries(reasoningFormatNames).map(([k, v]) => <option value={k} selected={format === k}>{v}</option>)}
					</select></div>);
				}
				arr.push(<EditWidget value={content} onChange={(value) => think.content = value}/>);
				container.replaceWith(...arr);
			} else {
				renderMarkdownToElement(container, content);
			}
		}
	}

	const title = think.title;
	return (
		<details className={'think'} class:thinking={() => !!think.start} open={config.expandThinkBlock && isReactive(think)}>
			<summary title={title || '展开思考过程'} onClick.once={renderContentAtFirstOpen}>
				<span className="chevron ri-play-large-fill"></span>
				{title || $computed(() => {
					let duration = think.duration;
					if (null == duration) return "已完成思考";

					if ("start" in think) duration += Date.now() - think.start;
					return "已思考 " + Math.round(duration / 1000) + " 秒";
				})}
			</summary>
			<div ref={container} className="think-content md">
				<button className={"ri-file-copy-line ghost"} title={"复制"} onClick={({target}) => {
					copyButtonAnimation(think.content, target);
				}}></button>
			</div>
		</details>
	);
}