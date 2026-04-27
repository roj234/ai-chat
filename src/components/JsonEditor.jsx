import "./JsonEditor.css";
import {$state, $watchWithCleanup} from "unconscious";
import morphdom from "morphdom";
import {lightSync} from "../markdown/highlight.js";
import {StreamJsonParser} from "/common/StreamJsonParser.js";

export const JsonEditor = ({value = ""}) => {
	const state = $state(value);
	let pre, code;
	/**
	 * @type {HTMLTextAreaElement}
	 */
	let textarea;

	function update() {
		let codeStr = state.value = textarea.value;

		const parser = StreamJsonParser(() => {});
		try {
			parser.write(codeStr);
			parser.end();
		} catch (e) {
			const errorNear = parser.pos - 1;
			codeStr = codeStr.slice(0, errorNear)+"\0"+codeStr.slice(errorNear);
		}

		morphdom(code, "<code>"+lightSync(codeStr, "json").replace("\0", "<span class='cursor'></span>")+"</code>");
	}

	const el = <div className="args CodeEditor">
		<pre ref={pre}><code ref={code}></code></pre>
		<textarea ref={textarea} spellCheck={false} value={state} onInput={update} onKeyDown={event => {
			if (event.key === "Tab") {
				event.preventDefault();
				textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
			}
		}} onScroll={() => {
			pre.scrollLeft = textarea.scrollLeft;
			pre.scrollTop = textarea.scrollTop;
		}}></textarea>
	</div>;
	$watchWithCleanup(state, update);
	return el;
}