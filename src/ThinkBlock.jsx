import {$computed, isReactive, unconscious} from "unconscious";
import './ThinkBlock.css';
import {markdown} from "./markdown-stream.js";

/**
 *
 * @param {AiChat.Thinking} think
 * @return {JSX.Element|null}
 * @constructor
 */
export function ThinkBlock({think}) {
	if (!think) return null;

	const durationSec = $computed(() => Math.max(0, Math.round(unconscious(think.duration) / 1000)));

	let content;
	const renderContentAtFirstOpen = () => {
		if (think.content && !isReactive(think))
			content.innerHTML = markdown.render(unconscious(think.content));
	}

	return (
		<details className='think'>
			<summary className="think-summary" title='思考过程' onClick.once={renderContentAtFirstOpen}>
				<span className="think-title">⏱ 已思考 {durationSec} 秒</span>
				<span className="chevron" aria-hidden>▾</span>
			</summary>
			<div ref={content} className="think-content"></div>
		</details>
	);
}