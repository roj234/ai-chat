import {$computed, $state, $watch, isReactive} from "unconscious";
import './ThinkBlock.css';
import {renderMarkdownToElement} from "../markdown/markdown.js";
import {EditWidget} from "./EditWidget.jsx";
import {config} from "../states.js";
import {JsonEditor} from "./JsonEditor.jsx";
import {inspect} from "unconscious/common/inspect.js";

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
			str += item.summary + "\n\n";
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

export const DONT_PARSE_HTML_IN_THINKING = {allowedTags: []};

/**
 *
 * @param {AiChat.Thinking} think
 * @param {AiChat.AssistantMessage} message
 * @param {boolean} edit
 * @return {JSX.Element|null}
 */
export function ThinkBlock({think, message, edit}) {
	if (!think) return null;

	let container;
	const renderContentAtFirstOpen = () => {
		if (!isReactive(think)) {
			let {content, format} = think;
			const details = message.reasoning_details;
			if (!content) {
				if (!details) return;
				content = extractReasoningTextFromDetails(details);
			}
			if (edit) {
				const arr = [];
				if (details) {
					const thinkState = $state();
					if (details.length === 1 && details[0].type === "reasoning.text" && details[0].format === "unknown") {
						arr.push(<EditWidget value={details[0].text} onChange={(value) => details[0].text = value}/>);
					} else {
						arr.push(<JsonEditor value={inspect(details)} state={thinkState}/>);
						arr.push(<div className={"args error"}
									  style:display={() => thinkState.error ? "" : "none"}>{() => thinkState.error}</div>);
						$watch(thinkState, () => {
							if (thinkState.obj) {
								message.reasoning_details = thinkState.obj;
							}
						}, false);
					}
				} else {
					if (format != null) {
						arr.push(<div style={"font-size:14px"}>思维链格式&nbsp;&nbsp;<select onChange={({target}) => {
							think.format = target.selectedOptions[0].value;
						}}>
							{Object.entries(reasoningFormatNames).map(([k, v]) => <option value={k}
																						  selected={format === k}>{v}</option>)}
						</select></div>);
					}
					arr.push(<EditWidget value={content} onChange={(value) => think.content = value}/>);
				}
				container.replaceWith(<div style="background:var(--panel-2)">{arr}</div>);
			} else {
				container.replaceChildren();
				renderMarkdownToElement(container, content, DONT_PARSE_HTML_IN_THINKING);
			}
		}
	}

	const title = think.title;
	return (
		<details className={'think'} class:thinking={() => !!think.start}
				 open={config.expandThinkBlock && isReactive(think)}
				 onToggle.once={renderContentAtFirstOpen}>
			<summary title={title || '展开思考过程'}>
				<span className="chevron ri-play-large-fill"></span>
				{edit ? "编辑思维链" + (message.reasoning_details ? " [结构化，可能加密]" : '') : title || $computed(() => {
					let duration = think.duration;
					if (null == duration) return "已完成思考";

					if ("start" in think) duration += Date.now() - think.start;
					return "已思考 " + Math.round(duration / 1000) + " 秒";
				})}
			</summary>
			<div ref={container} className="md"><p>加载中……</p></div>
			<CollapseButton/>
		</details>
	);
}

export const CollapseButton = () => <button className="collapse ri-collapse-vertical-line ghost" title="收起"
			onClick={({target}) => {target.closest("details").open = false;
}} />;