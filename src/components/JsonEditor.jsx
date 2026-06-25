import "./JsonEditor.css";
import {$cleanup, $state, $watchWithCleanup, AS_IS, preserveState} from "unconscious";
import {createJsonParser} from "unconscious/common/Json.js";
import {lightAsync} from "../markdown/highlight.js";
import morphdom from "morphdom";

const commonPrefix = (a, b) => {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
};
const commonSuffix = (a, b, prefix) => {
	const n = Math.min(a.length, b.length) - prefix;
	let i = 0;
	while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return i;
};

const findPosition = (root, targetOffset) => {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let currentOffset = 0;
	let node;
	while ((node = walker.nextNode())) {
		const len = node.nodeValue.length;
		if (currentOffset + len >= targetOffset) {
			return [ node, targetOffset - currentOffset ];
		}
		currentOffset += len;
	}
	return [ root, root.childNodes.length ];
};

export const JsonEditor = ({value = "", state}) => {
	const currentText = preserveState($state(value));
	let pre;
	/** @type {HTMLTextAreaElement} */
	let textarea;

	let lastText = "";
	let cancelHighlight;

	const scheduleHighlight = () => {
		cancelHighlight?.();
		let errorPos;

		let codeStr = currentText.value = textarea.value;
		const parser = createJsonParser(AS_IS, {json5: true});
		try {
			parser.write(codeStr);
			const obj = parser.end();
			if (state) state.value = { obj };
		} catch (e) {
			if (state) state.value = { error: e + " near index " + parser.pos() };
			errorPos = parser.pos();
		}

		let timer = setTimeout(() => {
			cancelHighlight = lightAsync(codeStr, "json", (html) => {
				cancelHighlight = null;
				lastText = codeStr;
				morphdom(pre, "<pre>"+html+"</pre>");
				if (errorPos != null) {
					const cursor = <span className='cursor'></span>;

					const range = document.createRange();
					const pos = findPosition(pre, errorPos);
					range.setStart(...pos);
					if (errorPos >= codeStr.length)
						range.insertNode(new Text("\n"));
					range.insertNode(cursor);
				}
			});
		}, 100);
		cancelHighlight = () => clearTimeout(timer);
	};

	const simpleHighlight = () => {
		const newText = textarea.value;
		const oldText = lastText;

		if (newText === oldText) return;

		const prefix = commonPrefix(oldText, newText);
		const suffix = commonSuffix(oldText, newText, prefix);

		const range = document.createRange();
		range.setStart(...findPosition(pre, prefix));
		range.setEnd(...findPosition(pre, oldText.length - suffix));
		range.deleteContents();

		const insertedText = newText.slice(prefix, newText.length - suffix);
		if (insertedText) range.insertNode(new Text(insertedText));

		lastText = newText;
	};

	function update() {
		simpleHighlight();
		scheduleHighlight();
	}

	const el = <div className="args CodeEditor">
		<pre ref={pre}></pre>
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
	$cleanup(el, () => cancelHighlight?.());
	return el;
};