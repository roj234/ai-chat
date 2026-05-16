import "./JsonEditor.css";
import {$state, $watchWithCleanup, AS_IS, preserveState} from "unconscious";
import morphdom from "morphdom";
import {lightSync} from "../markdown/highlight.js";
import {createJsonParser} from "unconscious/common/Json.js";

const highlightJson = (text) => lightSync(text, "json");

export const JsonEditor = ({value = "", state}) => {
	const currentText = preserveState($state(value));
	let pre, code;
	/**
	 * @type {HTMLTextAreaElement}
	 */
	let textarea;

	function update() {
		let codeStr = currentText.value = textarea.value;

		const parser = createJsonParser(AS_IS);
		try {
			parser.write(codeStr);
			const obj = parser.end();
			if (state) state.value = { obj };

			morphdom(code, "<code>"+highlightJson(codeStr)+"</code>");
		} catch (e) {
			if (state) state.value = { error: e+" near index "+parser.pos() };

			const errorNear = parser.pos();
			morphdom(code, "<code>"+highlightJson(codeStr.slice(0, errorNear))+"<span class='cursor'></span>"+(highlightJson(codeStr.slice(errorNear))||"\n")+"</code>");
		}
	}

	const el = <div className="args CodeEditor">
		<pre ref={pre}><code ref={code}></code></pre>
		<textarea ref={textarea} spellCheck={false} value={currentText} onInput={update} onKeyDown={event => {
			if (event.key === "Tab") {
				event.preventDefault();
				textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
			}
		}} onScroll={() => {
			pre.scrollLeft = textarea.scrollLeft;
			pre.scrollTop = textarea.scrollTop;
		}}></textarea>
	</div>;
	$watchWithCleanup(currentText, update);
	return el;
}