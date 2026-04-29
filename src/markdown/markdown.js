import {copyButtonAnimation} from "../utils/utils.js";
import {formatDate} from "unconscious/ext/Utils.js";

import {fmdHTMLRenderer, registerCodeBlockRenderer} from "./renderer.js";
import {FastMDParser} from "fastmd";

const mdParserOptions = {
	allowedTags: ["details", "summary", "b", "em", "kbd", "!-- --"],
	parseQuotes: true,
	preserveLineBreaks: true
}

/**
 *
 * @param {HTMLElement} container
 * @param {string} md
 * @param {import("better-marked").ParserOptions=} options
 */
export function renderMarkdownToElement(container, md, options = {}) {
	//import.meta.env.DEV && document.querySelector(".panel div").append(container);
	const renderer = new fmdHTMLRenderer(container);
	const parser = new FastMDParser(renderer, {
		...mdParserOptions,
		...options
	});
	parser.write(md);
	parser.end();
}

/**
 *
 * @param {string} md
 * @return {string}
 */
export function renderMarkdownToString(md) {
	const root = <div />;

	const renderer = new fmdHTMLRenderer(root, { noHighlight: true, noImage: true });
	const parser = new FastMDParser(renderer);
	parser.write(md);
	parser.end();

	return root.innerHTML;
}

const LANGUAGE_TO_EXT = {
	javascript: 'js',
	typescript: 'ts',
	python: 'py',
	csharp: 'cs',
	rust: 'rs',
	ruby: 'rb',
	kotlin: 'kt',
	markdown: 'md',
	batch: 'bat',
	bash: 'sh',
	shell: 'sh',
	powershell: 'ps1',
	objectivec: 'mm',
	text: 'txt',
	mermaid: 'txt'
};

export {registerCodeBlockRenderer} from './renderer.js';

function getElementToCopy(el) {
	return el.parentElement.parentElement.nextElementSibling;
}

export const copyCodeEventHandler = (e) => {
	const btn = e.target.closest(".code-block button[data-action]");
	if (!btn) return;

	const code = getElementToCopy(btn);
	switch (btn.dataset.action) {
		case "copy": {
			copyButtonAnimation(code._value || code.textContent, btn);
		}
		break;
		case "save": {
			const url = URL.createObjectURL(new Blob([code._value || code.textContent]));
			const span = btn.parentElement.previousElementSibling;
			const filename = span.dataset.name;
			const lang = span.innerHTML.toLowerCase();

			// 也许chrome 124又改了什么
			//const a = <a href={url} download={filename || APP_NAME+"-"+formatDate("Y-m-d H_i_s")+"."+(LANGUAGE_TO_EXT[lang] ?? lang)} />
			const a = document.createElement('a');
			a.href = url;
			a.download = filename || APP_NAME+"-"+formatDate("Y-m-d H_i_s")+"."+(LANGUAGE_TO_EXT[lang] ?? lang);
			a.click();

			URL.revokeObjectURL(url);
		}
		break;
		/*case "open": {
			btn.closest("pre").querySelector(".hljs").classList.toggle("done");
		}*/
	}
};

export function markdownStreamParser() {
	let parser;
	let rendererOptions = { stream: true };
	let prevOutput;
	let bufferIndex;

	/**
	 * @param {string} buffer
	 * @param {HTMLElement} output
	 */
	function render(buffer, output) {
		if (prevOutput !== output) {
			if (parser) parser.end();
			if (!(prevOutput = output)) return;

			// 给AntiSlop的重试循环用
			output.replaceChildren();
			parser = new FastMDParser(new fmdHTMLRenderer(output, rendererOptions), mdParserOptions);
			bufferIndex = 0;
			rendererOptions.noHighlight = false;
		}
		if (!buffer || !parser) return;

		const renderStart = Date.now();
		parser.write(buffer.substring(bufferIndex));
		bufferIndex = buffer.length;

		// 卡顿时自动禁用语法高亮
		if (Date.now() - renderStart > 30) rendererOptions.noHighlight = true;
	}

	return render;
}
