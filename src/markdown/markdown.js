import {copyButtonAnimation} from "../utils/utils.js";
import {formatDate} from "unconscious/common/Utils.js";

import {createMarkdownRenderer} from "./renderer.js";
import {createMarkdownParser} from "fastmd";

import "./markdown.css";

const mdParserOptions = {
	allowedTags: [
		"details", "summary",
		"b", "i", "u", "p", "br", "em", "kbd", "q", "strong",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"table", "th", "tr", "td", "thead", "tbody",
		"ul", "ol", "li",
		"section",  "div", "span", "hr", "mark",
		"img", "a",
	],
	preserveLineBreaks: true,
	allowNestedCodeFence3: true
}

/**
 *
 * @param {HTMLElement} container
 * @param {string} md
 * @param {import("fastmd").ParserOptions=} options
 */
export const renderMarkdownToElement = (container, md, options = {}) => {
	const renderer = createMarkdownRenderer(container);
	const parser = createMarkdownParser(renderer, {
		...mdParserOptions,
		parseQuotes: true,
		...options
	});
	parser.write(md);
	parser.end();
};

/**
 *
 * @param {string} md
 * @return {string}
 */
export const renderMarkdownToString = md => {
	const root = <div />;

	const renderer = createMarkdownRenderer(root, {
		...mdParserOptions,
		noHighlight: true,
		noImage: true
	});
	const parser = createMarkdownParser(renderer);
	parser.write(md);
	parser.end();

	return root.innerHTML;
};

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

/**
 * @param {Element} el
 * @return {Element}
 */
const getElementToCopy = el => el.parentElement.parentElement.nextElementSibling;

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
	}
};

const rendererOptions = { stream: true };

/**
 *
 * @param {HTMLElement} output
 * @return {import("fastmd").Parser}
 */
export const createStreamingMarkdownParser = output => {return createMarkdownParser(createMarkdownRenderer(output, rendererOptions), mdParserOptions);};

export const createMarkdownStream = () => {
	let parser;
	let prevOutput;
	let bufferIndex;

	/**
	 * @param {string} buffer
	 * @param {HTMLElement} output
	 */
	return (buffer, output) => {
		if (prevOutput !== output) {
			if (parser) parser.end();
			if (!(prevOutput = output)) return;

			// 给AntiSlop的重试循环用
			output.replaceChildren();
			parser = createStreamingMarkdownParser(output);
			bufferIndex = 0;
			rendererOptions.noHighlight = false;
		}
		if (!buffer || !parser) return;

		parser.write(buffer.slice(bufferIndex));
		bufferIndex = buffer.length;
	};
};
