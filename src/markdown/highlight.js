import hljs from "/vendor/hljs/core.js";
import morphdom from "morphdom";
import './highlight-theme.css';

import json from 'highlight.js/lib/languages/json';
import {VirtualList} from "unconscious/common/VirtualList.js";
import {$cleanup} from "unconscious";
import {onLoad} from "../plugin.js";
import {selectableVirtualListMixin} from "unconscious/common/selectableVirtualListMixin.js";
import {VOID_TAGS} from "fastmd";

hljs.registerLanguage('json', json);

// 换成白名单
const fullStreamableLanguages = new Set(["json"/*, "xml"*/]);

const light = (newCode, language) => hljs.highlight(newCode, {
	language,
	ignoreIllegals: true
});

/**
 *
 * @param {string} code
 * @param {string} language
 * @param onDone
 * @param [shouldStop]
 * @returns {(function(): void)|*}
 */
export const lightAsync = (code, language, onDone, shouldStop) => {
	const gen = light(code, language);
	let cancelled = false;
	let result;

	const step = () => {
		if (cancelled || shouldStop?.()) return;
		const start = performance.now();
		// Monkey Patch: yield every 256 time regexp matches
		while (!(result = gen.next()).done) {
			if (performance.now() - start > 8) {
				requestAnimationFrame(step);
				return;
			}
		}
		if (!cancelled) onDone(result.value.value);
	};

	requestAnimationFrame(step);
	return () => { cancelled = true; };
};

export const lightSync = (newCode, language) => {
	const gen = light(newCode, language);
	let result;
	while (!(result = gen.next()).done) ;
	return result.value.value;
};

// 辅助工具：提取并修补不完整的 HTML 行
const processLines = (rawHtml, openTagsStack = []) => {
	const lines = rawHtml.split('\n');
	return lines.map((lineContent, index) => {
		// 1. 在行首补全之前未闭合的标签
		let prefix = openTagsStack.map(tag => tag.full).join('');

		// 2. 分析当前行新增的标签状态
		// 匹配 <span class="..."> 或 </span>
		const tagRegex = /<(span) class="([^"]+)">|<\/(span)>/g;
		let match;
		let currentLineHtml = lineContent;

		while ((match = tagRegex.exec(lineContent)) !== null) {
			if (match[1] === 'span') { // 开始标签
				openTagsStack.push({name: 'span', full: match[0]});
			} else if (match[3] === 'span') { // 闭合标签
				openTagsStack.pop();
			}
		}

		// 3. 在行尾补全闭合标签（逆序闭合）
		let suffix = '</span>'.repeat(openTagsStack.length);

		return prefix + currentLineHtml + suffix;
	});
};

let heightTest;
onLoad((app) => {
	app.append(<pre className={"code-block"} style="position:absolute;visibility:hidden;pointer-events:none">
		<code className="hljs">
		<div ref={heightTest} className="line"/>
	</code>
	</pre>);
});

const getOrCreateVL = node => {
	let vl = node._vl;
	if (!vl) {
		node._vl = vl = new VirtualList({
			overscan: 50,
			itemHeight: heightTest.getBoundingClientRect().height,
			data: [{text: ""}],
			renderer: (item, index) => <div className={'line'} dangerouslySetInnerHTML={item.text ?? item}/>,
			keyFunc: (item) => item.text ?? item
		});
		vl._anchor = false;
		$cleanup(node, () => vl.destroy());
	}
	return vl;
};

/**
 * 语法高亮
 * @param {string} code
 * @param {string} language
 * @param {HTMLElement} node
 * @param {boolean} is_finished
 * @return {boolean}
 */
export const highlight = (code, language, node, is_finished) => {
	if (!code) return true;
	if (!node.className) node.className = "hljs";

	if (is_finished) {
		requestAnimationFrame(() => {
			node.scrollTop = node.scrollHeight;
		});
		node.dataset.finished = '1';
	}

	const callback = (code) => {
		if (is_finished) {
			delete node._cache;

			const lines = code.split('\n');
			const virtualList = getOrCreateVL(node);

			lightAsync(code, language, (value) => {
				if (!node.isConnected) return;

				node.style.height = node.offsetHeight + 'px';
				node.replaceChildren(virtualList.dom);
				virtualList.attach(node);
				selectableVirtualListMixin(virtualList, (line) => lines[line]);

				// noinspection JSPrimitiveTypeWrapperUsage
				virtualList.items = processLines(value, []).map(s => new String(s));
				virtualList.scrollToBottom();
				virtualList.render();
				node.style.height = '';
				virtualList.render();
				node._value = code;
			}, () => !node.isConnected);
			return;
		}

		let cache = node._cache;
		if (!cache) {
			const virtualList = getOrCreateVL(node);
			node._cache = cache = { work: <span/>, pos: 0 };
			node.replaceChildren(virtualList.dom);
			virtualList.attach(node);
		}
		const vl = node._vl;

		let newCode = code.slice(cache.pos);
		let newHtml = lightSync(newCode, language);

		// 除去白名单内的流式语言（例如JSON），在单行内应用 morphdom
		// 是的这就是他妈的比 shiki-stream 快，你去 benchmark 吧
		// 但是不支持 subLanguage 比如 JS/CSS in HTML 因为没有上下文
		let stableHtml = (fullStreamableLanguages.has(language) || newCode.includes("\n")) && trimLastTopLevelElement(newHtml);

		success: {
			if (stableHtml) {
				for (let reduced = 1; reduced < Math.min(250, newCode.length); reduced++) {
					const testLength = newCode.length - reduced;
					// 尽可能长的匹配字符串
					// 二分可以得到近似结果，但事实上不是线性关系，所以得不到精确结果
					const testHtml = lightSync(newCode.slice(0, testLength), language);

					// 后续依赖，如 'a(' 的 a 被高亮为函数但 '(' 本身不高亮
					if (!testHtml.startsWith(stableHtml)) break;

					if (testHtml === stableHtml) {
						const lines = processLines(testHtml, []);

						vl.items.at(-1).text += lines.shift();
						vl.items.push(...lines.map(i => {return{text:i}}));
						vl.render();

						cache.pos += testLength;

						newHtml = newHtml.slice(stableHtml.length);
						break success;
					}
				}
			}

			// 强制换行，避免长文本行性能崩溃
			if (newCode.length > 500) {
				vl.items.at(-1).text += newHtml;
				vl.items.push({text:""});
				vl.render();

				cache.pos += newCode.length;
				newHtml = '';
			}
		}

		const last = vl.dom.lastElementChild;
		if (last && last?.lastElementChild !== cache.work)
			last.append(cache.work);
		// 动态部分
		morphdom(cache.work, `<span>${newHtml}</span>`);
		vl.scrollTo(node.scrollHeight);
	};

	if (!hljs.getLanguage(language)) {
		if (!node.dataset.processed) {
			const onload = loadLanguage(language);
			if (onload) {
				node.dataset.processed = '1';
				onload.then((langName) => {
					language = langName;
					if (!is_finished) code = node._value || node.textContent;
					is_finished |= node.dataset.finished;

					delete node.dataset.finished;
					delete node.dataset.processed;
					callback(code);
				});
			}
		}

		return true;
	} else {
		callback(code);
	}
};

/**
 * 自适应JSON语法高亮 带格式化 调试用途
 * @param {any} obj
 * @param {number} maxChars 返回文本最大长度
 * @param {number} maxStringLen 单个字符串最大长度
 * @return {string}
 */
export const highlightJsonLike = (obj, maxChars = 10000, maxStringLen = 1000) => {
	let str = obj && typeof obj !== 'string' ? "/* 原始对象 */ " : "";
	let isJson;

	try {
		if (typeof obj === 'string') obj = JSON.parse(obj, (key, value) => {
			if (typeof value === 'string' && value.length > maxStringLen) {
				return value.slice(0, maxStringLen) + "... 与 " + (value.length - maxStringLen) + " 额外字符";
			}
			return value;
		});

		str += JSON.stringify(obj, null, 2).replace(/\[(?:[\n ]+(\d+|".*"),)+[\n ]+(\d+|".*")[\n ]+]/g, function (a) {
			return a.replace(/[\n ]+/g, ' ');
		});

		isJson = true;
	} catch {
		str += String(obj) || "/* 空字符串 */";
	}

	if (str.length > maxChars) str = str.slice(0, maxChars) + "\n/* 与 " + (str.length - maxChars) + " 额外字符 */";

	return /*isJson ? */lightSync(str, 'json');
};

/**
 *
 * @param {string} originalHtml
 * @return {string|false}
 */
const trimLastTopLevelElement = originalHtml => {
	//if (typeof originalHtml !== 'string') return false;

	// 纯文本
	const lastTag = originalHtml.lastIndexOf('>') + 1;
	if (!lastTag) return '';

	// 尾部文本
	const trailer = originalHtml.slice(lastTag);
	if (trailer.trim()) {
		if (!trailer.includes('<'))
			return originalHtml.slice(0, lastTag);

		console.error("未闭合的标签", trailer);
		return false;
	}

	const tagRegex = /^<\/?([a-zA-Z][a-zA-Z0-9-]*).*?\/?>/;
	const tagStack = [];
	let i = originalHtml.length;

	while (true) {
		const prev = originalHtml.lastIndexOf('<', i-1);
		if (prev < 0) {
			console.error("未打开的标签", tagStack[tagStack.length-1]);
			return false;
		}

		const match = tagRegex.exec(originalHtml.slice(prev, i));
		if (!match) {
			console.error("非法的标签", originalHtml.slice(prev, i));
			return false;
		}
		i = prev;

		const [m, tagName] = match;
		if (m.startsWith("</")) {
			// closing
			tagStack.push(tagName);
		} else {
			if (!VOID_TAGS.has(tagName) && !m.endsWith("/>")) {
				const expectedTag = tagStack.pop();
				if (expectedTag !== tagName) {
					console.error("不匹配的标签", expectedTag, tagName);
					return false;
				}
			}

			if (tagStack.length === 0) break;
		}
	}

	return originalHtml.slice(0, i);
};

/**
 * 加载语言
 * @param {string} languageName
 * @return {null | Promise<string>}
 */
const loadLanguage = languageName => {
	const initial_id = languageName;
	let asyncLoader;

	for(;;) {
		if (hljs.getLanguage(languageName)) {
			hljs.registerAliases([initial_id], {languageName});
			return Promise.resolve(languageName);
		}

		asyncLoader = LANGUAGES[languageName];
		if (typeof asyncLoader !== 'string') {
			if (typeof asyncLoader !== 'function')
				return asyncLoader;

			let promise = asyncLoader().then(async m => {
				hljs.registerLanguage(languageName, m.default);
				return languageName;
			});
			LANGUAGES[languageName] = promise;

			const dep = DEPS[languageName];
			if (dep) promise = Promise.all([promise, ...dep.map(loadLanguage)]).then(() => languageName);

			LANGUAGES[languageName] = promise;
			return promise;
		}
		languageName = asyncLoader;
	}
};

//region 程序生成，勿动
const DEPS = {
	asciidoc: ['xml'],
	shell: ['bash'],
	mojolicious: ['xml', 'perl'],
	"vbscript-html": ['xml', 'vbscript'],
	twig: ['xml'],
	handlebars: ['xml'],
	dust: ['xml'],
	javascript: ['xml', 'css', 'graphql'],
	django: ['xml'],
	perl: ['mojolicious'],
	xquery: ['xml'],
	qml: ['xml'],
	pgsql: [
		'pgsql',
		'perl',
		'python',
		'tcl',
		'r',
		'lua',
		'java',
		'php',
		'ruby',
		'bash',
		'scheme',
		'xml',
		//'json'
	],
	dart: ['markdown'],
	dockerfile: ['bash'],
	xml: ['css', 'javascript'],
	tap: ['yaml'],
	markdown: ['xml'],
	typescript: ['xml', 'css', 'graphql'],
	nix: ['markdown'],
	erb: ['xml'],
	haml: ['ruby'],
	yaml: ['ruby'],
};
const LANGUAGES = {
	"jsonl": "json",
	"vue": "xml",
	"asp": "vbscript-html",
	"aspx": "asp",
	"abnf": () => import('highlight.js/lib/languages/abnf'),
	"accesslog": () => import('highlight.js/lib/languages/accesslog'),
	"apache": () => import('highlight.js/lib/languages/apache'),
	"apacheconf": "apache",
	"arduino": () => import('highlight.js/lib/languages/arduino'),
	"armasm": () => import('highlight.js/lib/languages/armasm'),
	"asciidoc": () => import('highlight.js/lib/languages/asciidoc'),
	"adoc": "asciidoc",
	"awk": () => import('highlight.js/lib/languages/awk'),
	"bash": () => import('highlight.js/lib/languages/bash'),
	"sh": "bash",
	"bnf": () => import('highlight.js/lib/languages/bnf'),
	"c": () => import('highlight.js/lib/languages/c'),
	"clojure": () => import('highlight.js/lib/languages/clojure'),
	"cmake": () => import('highlight.js/lib/languages/cmake'),
	"coq": () => import('highlight.js/lib/languages/coq'),
	"cpp": () => import('highlight.js/lib/languages/cpp'),
	"csharp": () => import('highlight.js/lib/languages/csharp'),
	"cs": "csharp",
	"css": () => import('highlight.js/lib/languages/css'),
	"d": () => import('highlight.js/lib/languages/d'),
	"dart": () => import('highlight.js/lib/languages/dart'),
	"diff": () => import('highlight.js/lib/languages/diff'),
	"patch": "diff",
	"django": () => import('highlight.js/lib/languages/django'),
	"jinja": "django",
	"dns": () => import('highlight.js/lib/languages/dns'),
	"dockerfile": () => import('highlight.js/lib/languages/dockerfile'),
	"docker": "dockerfile",
	"dos": () => import('highlight.js/lib/languages/dos'),
	"bat": "dos",
	"cmd": "dos",
	"batch": "dos",
	"dts": () => import('highlight.js/lib/languages/dts'),
	"ebnf": () => import('highlight.js/lib/languages/ebnf'),
	"elixir": () => import('highlight.js/lib/languages/elixir'),
	"elm": () => import('highlight.js/lib/languages/elm'),
	"erb": () => import('highlight.js/lib/languages/erb'),
	"erlang": () => import('highlight.js/lib/languages/erlang'),
	"fortran": () => import('highlight.js/lib/languages/fortran'),
	"fsharp": () => import('highlight.js/lib/languages/fsharp'),
	"glsl": () => import('highlight.js/lib/languages/glsl'),
	"go": () => import('highlight.js/lib/languages/go'),
	"golang": "go",
	"gradle": () => import('highlight.js/lib/languages/gradle'),
	"graphql": () => import('highlight.js/lib/languages/graphql'),
	"gql": "graphql",
	"groovy": () => import('highlight.js/lib/languages/groovy'),
	"haml": () => import('highlight.js/lib/languages/haml'),
	"handlebars": () => import('highlight.js/lib/languages/handlebars'),
	"haskell": () => import('highlight.js/lib/languages/haskell'),
	"hs": "haskell",
	"haxe": () => import('highlight.js/lib/languages/haxe'),
	"hx": "haxe",
	"http": () => import('highlight.js/lib/languages/http'),
	"ini": () => import('highlight.js/lib/languages/ini'),
	"toml": "ini",
	"java": () => import('highlight.js/lib/languages/java'),
	"jsp": "java",
	"javascript": () => import('highlight.js/lib/languages/javascript'),
	"js": "javascript",
	"jsx": "javascript",
	//"json": () => import('highlight.js/lib/languages/json'),
	"jsonc": "json",
	"julia": () => import('highlight.js/lib/languages/julia'),
	"kotlin": () => import('highlight.js/lib/languages/kotlin'),
	"kt": "kotlin",
	"kts": "kotlin",
	"latex": () => import('highlight.js/lib/languages/latex'),
	"tex": "latex",
	"less": () => import('highlight.js/lib/languages/less'),
	"lisp": () => import('highlight.js/lib/languages/lisp'),
	"llvm": () => import('highlight.js/lib/languages/llvm'),
	"lua": () => import('highlight.js/lib/languages/lua'),
	"makefile": () => import('highlight.js/lib/languages/makefile'),
	"make": "makefile",
	"markdown": () => import('highlight.js/lib/languages/markdown'),
	"md": "markdown",
	"matlab": () => import('highlight.js/lib/languages/matlab'),
	"mojolicious": () => import('highlight.js/lib/languages/mojolicious'),
	"nginx": () => import('highlight.js/lib/languages/nginx'),
	"nginxconf": "nginx",
	"nix": () => import('highlight.js/lib/languages/nix'),
	"nixos": "nix",
	"objectivec": () => import('highlight.js/lib/languages/objectivec'),
	"mm": "objectivec",
	"objc": "objectivec",
	"ocaml": () => import('highlight.js/lib/languages/ocaml'),
	"ml": "ocaml",
	"perl": () => import('highlight.js/lib/languages/perl'),
	"pgsql": () => import('highlight.js/lib/languages/pgsql'),
	"postgres": "pgsql",
	"postgresql": "pgsql",
	"php": () => import('highlight.js/lib/languages/php'),
	"powershell": () => import('highlight.js/lib/languages/powershell'),
	"pwsh": "powershell",
	"ps": "powershell",
	"processing": () => import('highlight.js/lib/languages/processing'),
	"pde": "processing",
	"prolog": () => import('highlight.js/lib/languages/prolog'),
	"properties": () => import('highlight.js/lib/languages/properties'),
	"protobuf": () => import('highlight.js/lib/languages/protobuf'),
	"proto": "protobuf",
	"puppet": () => import('highlight.js/lib/languages/puppet'),
	"pp": "puppet",
	"python": () => import('highlight.js/lib/languages/python'),
	"py": "python",
	"qml": () => import('highlight.js/lib/languages/qml'),
	"qt": "qml",
	"r": () => import('highlight.js/lib/languages/r'),
	"ruby": () => import('highlight.js/lib/languages/ruby'),
	"rust": () => import('highlight.js/lib/languages/rust'),
	"sas": () => import('highlight.js/lib/languages/sas'),
	"scala": () => import('highlight.js/lib/languages/scala'),
	"scheme": () => import('highlight.js/lib/languages/scheme'),
	"scss": () => import('highlight.js/lib/languages/scss'),
	"shell": () => import('highlight.js/lib/languages/shell'),
	"smali": () => import('highlight.js/lib/languages/smali'),
	"sql": () => import('highlight.js/lib/languages/sql'),
	"stylus": () => import('highlight.js/lib/languages/stylus'),
	"swift": () => import('highlight.js/lib/languages/swift'),
	"tcl": () => import('highlight.js/lib/languages/tcl'),
	"thrift": () => import('highlight.js/lib/languages/thrift'),
	"twig": () => import('highlight.js/lib/languages/twig'),
	"typescript": () => import('highlight.js/lib/languages/typescript'),
	"ts": "typescript",
	"tsx": "typescript",
	"vbnet": () => import('highlight.js/lib/languages/vbnet'),
	"vb": "vbnet",
	"vbscript-html": () => import('highlight.js/lib/languages/vbscript-html'),
	"vbscript": () => import('highlight.js/lib/languages/vbscript'),
	"vbs": "vbscript",
	"verilog": () => import('highlight.js/lib/languages/verilog'),
	"vhdl": () => import('highlight.js/lib/languages/vhdl'),
	"vim": () => import('highlight.js/lib/languages/vim'),
	"wasm": () => import('highlight.js/lib/languages/wasm'),
	"x86asm": () => import('highlight.js/lib/languages/x86asm'),
	"xml": () => import('highlight.js/lib/languages/xml'),
	"html": "xml",
	"svg": "xml",
	"yaml": () => import('highlight.js/lib/languages/yaml'),
	"yml": "yaml",
};
//endregion