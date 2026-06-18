import {copyButtonAnimation, downloadFile} from "../utils/utils.js";

import {createMarkdownRenderer} from "./renderer.js";
import {createMarkdownParser} from "fastmd";

import "./markdown.css";

const tags = {
	basic: [
		"details", "summary",
		"b", "i", "u", "p", "br", "em", "kbd", "q", "strong", "code", "ruby", "rp", "rt", "sup", "sub", "small",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"table", "th", "tr", "td", "thead", "tbody", "pre",
		"ul", "ol", "li",
		"section",  "div", "span", "hr", "mark",
		"img", "a",
	],
	style: ["style"],
	script: ["script"]
};

const mdParserOptions = {
	allowedTags: tags.basic,
	parseQuotes: true,
	preserveLineBreaks: true,
	allowNestedCodeFence3: true
}

/**
 *
 * @param {string[]} tagTypes
 */
export const setAllowHTMLTags = (tagTypes) => {
	const arr = [];
	if (tagTypes) for (let type of tagTypes) {
		arr.push(...tags[type]);
	}
	mdParserOptions.allowedTags = arr;
}

/**
 *
 * @param {HTMLElement} container
 * @param {string} md
 * @param {import("fastmd").ParserOptions & AiChat.MarkdownRendererOptions} options
 */
export const renderMarkdownToElement = (container, md, options = {}) => {
	const renderer = createMarkdownRenderer(container, options);
	const parser = createMarkdownParser(renderer, {
		...mdParserOptions,
		...options
	});
	parser.write(md);
	parser.end();
	return container;
};

/**
 *
 * @param {string} md
 * @return {string}
 */
export const renderMarkdownToString = md => {
	const root = <div />;

	const renderer = createMarkdownRenderer(root, {
		noHighlight: true,
		noImage: true
	});
	const parser = createMarkdownParser(renderer, {
		...mdParserOptions,
		parseQuotes: false,
	});
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
			const span = btn.parentElement.previousElementSibling;
			const filename = span.dataset.name;
			const lang = span.innerHTML.toLowerCase();

			const file = new (filename?File:Blob)([code._value || code.textContent], filename);
			downloadFile(file, LANGUAGE_TO_EXT[lang] ?? lang);
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
		}
		if (!buffer || !parser) return;

		parser.write(buffer.slice(bufferIndex));
		bufferIndex = buffer.length;
	};
};
