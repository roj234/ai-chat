import {$computed, unconscious} from "unconscious";
import './ThinkBlock.css';

/**
 *
 * @param {AiChat.Thinking} think
 * @return {JSX.Element|null}
 * @constructor
 */
export function ThinkBlock({think}) {
	if (!think?.content) return null;

	const durationSec = $computed(() => Math.max(0, Math.round(unconscious(think.duration) / 1000)));

	return (
		<details className='think'>
			<summary className="think-summary" title='思考过程'>
				<span className="think-title">⏱ 已思考 {durationSec} 秒</span>
				<span className="chevron" aria-hidden>▾</span>
			</summary>
			<div className="think-content"><pre>{think.content}</pre></div>
		</details>
	);
}