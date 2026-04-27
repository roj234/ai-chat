import hljs from "highlight.js/lib/core";
import morphdom from "morphdom";
import './highlight-theme.css';

import json from 'highlight.js/lib/languages/json';

hljs.registerLanguage('json', json);

// 换成白名单
const fullStreamableLanguages = new Set(["json"/*, "xml"*/]);

function light(newCode, language) {
	return hljs.highlight(newCode, {
		language,
		ignoreIllegals: true
	}).value;
}

/**
 * 语法高亮
 * @param {string} code
 * @param {string} language
 * @param {HTMLElement} node
 * @param {boolean} is_end
 * @return {boolean}
 */
export function highlight(code, language, node, is_end) {
	function end() {
		node.classList.add("done");
		requestAnimationFrame(() => {
			node.scrollTop = node.scrollHeight;
		});
	}

	const callback = (code) => {
		if (is_end) {
			delete node._cache;
			// 最终做一次全量
			morphdom(node, `<code class="hljs">${light(code, language)}</code>`);
			end();
			return;
		}

		let cache = node._cache;
		if (!cache) {
			node._cache = cache = {
				work: <span/>,
				pos: 0
			};
			node.replaceChildren(cache.work);
		}

		let newCode = code.substring(cache.pos);
		let newHtml = light(newCode, language);

		// 除去白名单内的流式语言（例如JSON），在单行内应用 morphdom
		// 是的这就是他妈的比 shiki-stream 快，你去 benchmark 吧
		const stableHtml = (fullStreamableLanguages.has(language) || newCode.includes("\n")) && trimLastTopLevelElement(newHtml);
		if (stableHtml) {
			for (let reduced = 1; reduced < newCode.length; reduced++) {
				const testLength = newCode.length - reduced;
				// 尽可能长的匹配字符串
				// 二分可以得到近似结果，但事实上不是线性关系，所以得不到精确结果
				const testHtml = light(newCode.substring(0, testLength), language);

				// 后续依赖，如 'a(' 的 a 被高亮为函数但 '(' 本身不高亮
				if (!testHtml.startsWith(stableHtml)) break;

				if (testHtml === stableHtml) {
					// 持久化
					cache.work.insertAdjacentHTML('beforebegin', testHtml);
					cache.pos += testLength;

					newHtml = newHtml.substring(stableHtml.length);
					break;
				}
			}
		}

		// 动态部分
		morphdom(cache.work, `<span>${newHtml}</span>`);
	};

	if (!hljs.getLanguage(language)) {
		if (node.dataset.processed) return true;
		end();

		const loaded = loadLanguage(language);
		if (!loaded) return true;

		node.dataset.processed = "y";
		loaded.then((langName) => {
			delete node.dataset.processed;
			language = langName;
			callback(node._value || node.textContent);
		});
	} else {
		callback(code);
	}
}

/**
 * 自适应JSON语法高亮 带格式化 调试用途
 * @param {any} obj
 * @param {number} maxChars 返回文本最大长度
 * @param {number} maxStringLen 单个字符串最大长度
 * @return {string}
 */
export function highlightJsonLike(obj, maxChars = 10000, maxStringLen = 1000) {
	let str = obj && typeof obj !== 'string' ? "/* 原始对象 */ " : "";
	let isJson;

	try {
		if (typeof obj === 'string') obj = JSON.parse(obj, (key, value) => {
			if (typeof value === 'string' && value.length > maxStringLen) {
				return value.substring(0, maxStringLen) + "... 与 " + (value.length - maxStringLen) + " 额外字符";
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

	if (str.length > maxChars) str = str.substring(0, maxChars) + "\n/* 与 " + (str.length - maxChars) + " 额外字符 */";

	return /*isJson ? */hljs.highlight(str, {
		language: "json",
		ignoreIllegals: true
	}).value;
}

const VOID_TAGS = /*#__PURE__*/ new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);

/**
 *
 * @param {string} originalHtml
 * @return {string|false}
 */
function trimLastTopLevelElement(originalHtml) {
	//if (typeof originalHtml !== 'string') return false;

	// 纯文本
	const lastTag = originalHtml.lastIndexOf('>') + 1;
	if (!lastTag) return '';

	// 尾部文本
	const trailer = originalHtml.substring(lastTag);
	if (trailer.trim()) {
		if (!trailer.includes('<'))
			return originalHtml.substring(0, lastTag);

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

		const match = tagRegex.exec(originalHtml.substring(prev, i));
		if (!match) {
			console.error("非法的标签", originalHtml.substring(prev, i));
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

	return originalHtml.substring(0, i);
}

/**
 * 加载语言
 * @param {string} languageName
 * @return {null | Promise<string>}
 */
function loadLanguage(languageName) {
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
}

//region 程序生成，勿动
const DEPS = {
	livescript: ['javascript'],
	parser3: ['xml'],
	asciidoc: ['xml'],
	shell: ['bash'],
	cos: ['sql', 'javascript', 'xml'],
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
	coffeescript: ['javascript'],
	tap: ['yaml'],
	markdown: ['xml'],
	typescript: ['xml', 'css', 'graphql'],
	nix: ['markdown'],
	erb: ['xml'],
	haml: ['ruby'],
	yaml: ['ruby'],
};
const LANGUAGES = {
	"vue": "xml",
	"asp": "vbscript-html",
	"aspx": "asp",

	//"1c": () => import('highlight.js/lib/languages/1c'),
	"abnf": () => import('highlight.js/lib/languages/abnf'),
	"accesslog": () => import('highlight.js/lib/languages/accesslog'),
	"actionscript": () => import('highlight.js/lib/languages/actionscript'),
	"as": "actionscript",
	"ada": () => import('highlight.js/lib/languages/ada'),
	"angelscript": () => import('highlight.js/lib/languages/angelscript'),
	"asc": "angelscript",
	"apache": () => import('highlight.js/lib/languages/apache'),
	"apacheconf": "apache",
	"applescript": () => import('highlight.js/lib/languages/applescript'),
	"osascript": "applescript",
	"arcade": () => import('highlight.js/lib/languages/arcade'),
	"arduino": () => import('highlight.js/lib/languages/arduino'),
	"ino": "arduino",
	"armasm": () => import('highlight.js/lib/languages/armasm'),
	"arm": "armasm",
	"asciidoc": () => import('highlight.js/lib/languages/asciidoc'),
	"adoc": "asciidoc",
	"aspectj": () => import('highlight.js/lib/languages/aspectj'),
	"autohotkey": () => import('highlight.js/lib/languages/autohotkey'),
	"ahk": "autohotkey",
	"autoit": () => import('highlight.js/lib/languages/autoit'),
	"avrasm": () => import('highlight.js/lib/languages/avrasm'),
	"awk": () => import('highlight.js/lib/languages/awk'),
	"axapta": () => import('highlight.js/lib/languages/axapta'),
	"x++": "axapta",
	"bash": () => import('highlight.js/lib/languages/bash'),
	"sh": "bash",
	"zsh": "bash",
	"basic": () => import('highlight.js/lib/languages/basic'),
	"bnf": () => import('highlight.js/lib/languages/bnf'),
	"brainfuck": () => import('highlight.js/lib/languages/brainfuck'),
	"bf": "brainfuck",
	"c": () => import('highlight.js/lib/languages/c'),
	"h": "c",
	"cal": () => import('highlight.js/lib/languages/cal'),
	"capnproto": () => import('highlight.js/lib/languages/capnproto'),
	"capnp": "capnproto",
	"ceylon": () => import('highlight.js/lib/languages/ceylon'),
	"clean": () => import('highlight.js/lib/languages/clean'),
	"icl": "clean",
	"dcl": "clean",
	//"clojure-repl": () => import('highlight.js/lib/languages/clojure-repl'),
	"clojure": () => import('highlight.js/lib/languages/clojure'),
	"clj": "clojure",
	"edn": "clojure",
	"cmake": () => import('highlight.js/lib/languages/cmake'),
	"cmake.in": "cmake",
	"coffeescript": () => import('highlight.js/lib/languages/coffeescript'),
	"coffee": "coffeescript",
	"cson": "coffeescript",
	"iced": "coffeescript",
	"coq": () => import('highlight.js/lib/languages/coq'),
	"cos": () => import('highlight.js/lib/languages/cos'),
	"cls": "cos",
	"cpp": () => import('highlight.js/lib/languages/cpp'),
	"cc": "cpp",
	"c++": "cpp",
	"h++": "cpp",
	"hpp": "cpp",
	"hh": "cpp",
	"hxx": "cpp",
	"cxx": "cpp",
	"crmsh": () => import('highlight.js/lib/languages/crmsh'),
	"crm": "crmsh",
	"pcmk": "crmsh",
	"crystal": () => import('highlight.js/lib/languages/crystal'),
	"cr": "crystal",
	"csharp": () => import('highlight.js/lib/languages/csharp'),
	"cs": "csharp",
	"c#": "csharp",
	"csp": () => import('highlight.js/lib/languages/csp'),
	"css": () => import('highlight.js/lib/languages/css'),
	"d": () => import('highlight.js/lib/languages/d'),
	"dart": () => import('highlight.js/lib/languages/dart'),
	"delphi": () => import('highlight.js/lib/languages/delphi'),
	"dpr": "delphi",
	"dfm": "delphi",
	"pas": "delphi",
	"pascal": "delphi",
	"diff": () => import('highlight.js/lib/languages/diff'),
	"patch": "diff",
	"django": () => import('highlight.js/lib/languages/django'),
	"jinja": "django",
	"dns": () => import('highlight.js/lib/languages/dns'),
	"bind": "dns",
	"zone": "dns",
	"dockerfile": () => import('highlight.js/lib/languages/dockerfile'),
	"docker": "dockerfile",
	"dos": () => import('highlight.js/lib/languages/dos'),
	"bat": "dos",
	"cmd": "dos",
	"dsconfig": () => import('highlight.js/lib/languages/dsconfig'),
	"dts": () => import('highlight.js/lib/languages/dts'),
	"dust": () => import('highlight.js/lib/languages/dust'),
	"dst": "dust",
	"ebnf": () => import('highlight.js/lib/languages/ebnf'),
	"elixir": () => import('highlight.js/lib/languages/elixir'),
	"ex": "elixir",
	"exs": "elixir",
	"elm": () => import('highlight.js/lib/languages/elm'),
	"erb": () => import('highlight.js/lib/languages/erb'),
	"erlang": () => import('highlight.js/lib/languages/erlang'),
	"erl": "erlang",
	"excel": () => import('highlight.js/lib/languages/excel'),
	"xlsx": "excel",
	"xls": "excel",
	"fix": () => import('highlight.js/lib/languages/fix'),
	"flix": () => import('highlight.js/lib/languages/flix'),
	"fortran": () => import('highlight.js/lib/languages/fortran'),
	"f90": "fortran",
	"f95": "fortran",
	"fsharp": () => import('highlight.js/lib/languages/fsharp'),
	"fs": "fsharp",
	"f#": "fsharp",
	"gams": () => import('highlight.js/lib/languages/gams'),
	"gms": "gams",
	//"gauss": () => import('highlight.js/lib/languages/gauss'),
	//"gss": "gauss",
	"gcode": () => import('highlight.js/lib/languages/gcode'),
	"nc": "gcode",
	"gherkin": () => import('highlight.js/lib/languages/gherkin'),
	"feature": "gherkin",
	"glsl": () => import('highlight.js/lib/languages/glsl'),
	//"gml": () => import('highlight.js/lib/languages/gml'),
	"go": () => import('highlight.js/lib/languages/go'),
	"golang": "go",
	"golo": () => import('highlight.js/lib/languages/golo'),
	"gradle": () => import('highlight.js/lib/languages/gradle'),
	"graphql": () => import('highlight.js/lib/languages/graphql'),
	"gql": "graphql",
	"groovy": () => import('highlight.js/lib/languages/groovy'),
	"haml": () => import('highlight.js/lib/languages/haml'),
	"handlebars": () => import('highlight.js/lib/languages/handlebars'),
	"hbs": "handlebars",
	"html.hbs": "handlebars",
	"html.handlebars": "handlebars",
	"htmlbars": "handlebars",
	"haskell": () => import('highlight.js/lib/languages/haskell'),
	"hs": "haskell",
	"haxe": () => import('highlight.js/lib/languages/haxe'),
	"hx": "haxe",
	"hsp": () => import('highlight.js/lib/languages/hsp'),
	"http": () => import('highlight.js/lib/languages/http'),
	"https": "http",
	"hy": () => import('highlight.js/lib/languages/hy'),
	"hylang": "hy",
	"inform7": () => import('highlight.js/lib/languages/inform7'),
	"i7": "inform7",
	"ini": () => import('highlight.js/lib/languages/ini'),
	"toml": "ini",
	"irpf90": () => import('highlight.js/lib/languages/irpf90'),
	//"isbl": () => import('highlight.js/lib/languages/isbl'),
	"java": () => import('highlight.js/lib/languages/java'),
	"jsp": "java",
	"javascript": () => import('highlight.js/lib/languages/javascript'),
	"js": "javascript",
	"jsx": "javascript",
	"mjs": "javascript",
	"cjs": "javascript",
	"jboss-cli": () => import('highlight.js/lib/languages/jboss-cli'),
	"wildfly-cli": "jboss-cli",
	//"json": () => import('highlight.js/lib/languages/json'),
	"jsonc": "json",
	//"julia-repl": () => import('highlight.js/lib/languages/julia-repl'),
	//"jldoctest": "julia-repl",
	"julia": () => import('highlight.js/lib/languages/julia'),
	"kotlin": () => import('highlight.js/lib/languages/kotlin'),
	"kt": "kotlin",
	"kts": "kotlin",
	"lasso": () => import('highlight.js/lib/languages/lasso'),
	"ls": "lasso",
	"lassoscript": "lasso",
	"latex": () => import('highlight.js/lib/languages/latex'),
	"tex": "latex",
	"ldif": () => import('highlight.js/lib/languages/ldif'),
	"leaf": () => import('highlight.js/lib/languages/leaf'),
	"less": () => import('highlight.js/lib/languages/less'),
	"lisp": () => import('highlight.js/lib/languages/lisp'),
	//"livecodeserver": () => import('highlight.js/lib/languages/livecodeserver'),
	"livescript": () => import('highlight.js/lib/languages/livescript'),
	"ls": "livescript",
	"llvm": () => import('highlight.js/lib/languages/llvm'),
	"lsl": () => import('highlight.js/lib/languages/lsl'),
	"lua": () => import('highlight.js/lib/languages/lua'),
	"pluto": "lua",
	"makefile": () => import('highlight.js/lib/languages/makefile'),
	"mk": "makefile",
	"mak": "makefile",
	"make": "makefile",
	"markdown": () => import('highlight.js/lib/languages/markdown'),
	"md": "markdown",
	"mkdown": "markdown",
	"mkd": "markdown",
	//"mathematica": () => import('highlight.js/lib/languages/mathematica'),
	//"mma": "mathematica",
	//"wl": "mathematica",
	"matlab": () => import('highlight.js/lib/languages/matlab'),
	//"maxima": () => import('highlight.js/lib/languages/maxima'),
	"mel": () => import('highlight.js/lib/languages/mel'),
	"mercury": () => import('highlight.js/lib/languages/mercury'),
	"m": "mercury",
	"moo": "mercury",
	"mipsasm": () => import('highlight.js/lib/languages/mipsasm'),
	"mips": "mipsasm",
	"mizar": () => import('highlight.js/lib/languages/mizar'),
	"mojolicious": () => import('highlight.js/lib/languages/mojolicious'),
	"monkey": () => import('highlight.js/lib/languages/monkey'),
	"moonscript": () => import('highlight.js/lib/languages/moonscript'),
	"moon": "moonscript",
	"n1ql": () => import('highlight.js/lib/languages/n1ql'),
	"nestedtext": () => import('highlight.js/lib/languages/nestedtext'),
	"nt": "nestedtext",
	"nginx": () => import('highlight.js/lib/languages/nginx'),
	"nginxconf": "nginx",
	"nim": () => import('highlight.js/lib/languages/nim'),
	"nix": () => import('highlight.js/lib/languages/nix'),
	"nixos": "nix",
	//"node-repl": () => import('highlight.js/lib/languages/node-repl'),
	"nsis": () => import('highlight.js/lib/languages/nsis'),
	"objectivec": () => import('highlight.js/lib/languages/objectivec'),
	"mm": "objectivec",
	"objc": "objectivec",
	"obj-c": "objectivec",
	"obj-c++": "objectivec",
	"objective-c++": "objectivec",
	"ocaml": () => import('highlight.js/lib/languages/ocaml'),
	"ml": "ocaml",
	"openscad": () => import('highlight.js/lib/languages/openscad'),
	"scad": "openscad",
	"oxygene": () => import('highlight.js/lib/languages/oxygene'),
	"parser3": () => import('highlight.js/lib/languages/parser3'),
	"perl": () => import('highlight.js/lib/languages/perl'),
	"pl": "perl",
	"pm": "perl",
	"pf": () => import('highlight.js/lib/languages/pf'),
	"pf.conf": "pf",
	"pgsql": () => import('highlight.js/lib/languages/pgsql'),
	"postgres": "pgsql",
	"postgresql": "pgsql",
	//"php-template": () => import('highlight.js/lib/languages/php-template'),
	"php": () => import('highlight.js/lib/languages/php'),
	//"plaintext": () => import('highlight.js/lib/languages/plaintext'),
	//"text": "plaintext",
	//"txt": "plaintext",
	"pony": () => import('highlight.js/lib/languages/pony'),
	"powershell": () => import('highlight.js/lib/languages/powershell'),
	"pwsh": "powershell",
	"ps": "powershell",
	"ps1": "powershell",
	"processing": () => import('highlight.js/lib/languages/processing'),
	"pde": "processing",
	"profile": () => import('highlight.js/lib/languages/profile'),
	"prolog": () => import('highlight.js/lib/languages/prolog'),
	"properties": () => import('highlight.js/lib/languages/properties'),
	"protobuf": () => import('highlight.js/lib/languages/protobuf'),
	"proto": "protobuf",
	"puppet": () => import('highlight.js/lib/languages/puppet'),
	"pp": "puppet",
	"purebasic": () => import('highlight.js/lib/languages/purebasic'),
	"pb": "purebasic",
	"pbi": "purebasic",
	//"python-repl": () => import('highlight.js/lib/languages/python-repl'),
	//"pycon": "python-repl",
	"python": () => import('highlight.js/lib/languages/python'),
	"py": "python",
	"gyp": "python",
	"ipython": "python",
	"q": () => import('highlight.js/lib/languages/q'),
	"k": "q",
	"kdb": "q",
	"qml": () => import('highlight.js/lib/languages/qml'),
	"qt": "qml",
	"r": () => import('highlight.js/lib/languages/r'),
	"reasonml": () => import('highlight.js/lib/languages/reasonml'),
	"re": "reasonml",
	"rib": () => import('highlight.js/lib/languages/rib'),
	"roboconf": () => import('highlight.js/lib/languages/roboconf'),
	"graph": "roboconf",
	"instances": "roboconf",
	"routeros": () => import('highlight.js/lib/languages/routeros'),
	"mikrotik": "routeros",
	"rsl": () => import('highlight.js/lib/languages/rsl'),
	"ruby": () => import('highlight.js/lib/languages/ruby'),
	"rb": "ruby",
	"gemspec": "ruby",
	"podspec": "ruby",
	"thor": "ruby",
	"irb": "ruby",
	"ruleslanguage": () => import('highlight.js/lib/languages/ruleslanguage'),
	"rust": () => import('highlight.js/lib/languages/rust'),
	"rs": "rust",
	"sas": () => import('highlight.js/lib/languages/sas'),
	"scala": () => import('highlight.js/lib/languages/scala'),
	"scheme": () => import('highlight.js/lib/languages/scheme'),
	"scm": "scheme",
	"scilab": () => import('highlight.js/lib/languages/scilab'),
	"sci": "scilab",
	"scss": () => import('highlight.js/lib/languages/scss'),
	"shell": () => import('highlight.js/lib/languages/shell'),
	"console": "shell",
	"shellsession": "shell",
	"smali": () => import('highlight.js/lib/languages/smali'),
	"smalltalk": () => import('highlight.js/lib/languages/smalltalk'),
	"st": "smalltalk",
	//"sml": () => import('highlight.js/lib/languages/sml'),
	//"ml": "sml",
	//"sqf": () => import('highlight.js/lib/languages/sqf'),
	"sql": () => import('highlight.js/lib/languages/sql'),
	"stan": () => import('highlight.js/lib/languages/stan'),
	"stanfuncs": "stan",
	//"stata": () => import('highlight.js/lib/languages/stata'),
	//"do": "stata",
	//"ado": "stata",
	"step21": () => import('highlight.js/lib/languages/step21'),
	"p21": "step21",
	"step": "step21",
	"stp": "step21",
	"stylus": () => import('highlight.js/lib/languages/stylus'),
	"styl": "stylus",
	"subunit": () => import('highlight.js/lib/languages/subunit'),
	"swift": () => import('highlight.js/lib/languages/swift'),
	"taggerscript": () => import('highlight.js/lib/languages/taggerscript'),
	"tap": () => import('highlight.js/lib/languages/tap'),
	"tcl": () => import('highlight.js/lib/languages/tcl'),
	"tk": "tcl",
	"thrift": () => import('highlight.js/lib/languages/thrift'),
	"tp": () => import('highlight.js/lib/languages/tp'),
	"twig": () => import('highlight.js/lib/languages/twig'),
	"craftcms": "twig",
	"typescript": () => import('highlight.js/lib/languages/typescript'),
	"ts": "typescript",
	"tsx": "typescript",
	"mts": "typescript",
	"cts": "typescript",
	"vala": () => import('highlight.js/lib/languages/vala'),
	"vbnet": () => import('highlight.js/lib/languages/vbnet'),
	"vb": "vbnet",
	"vbscript-html": () => import('highlight.js/lib/languages/vbscript-html'),
	"vbscript": () => import('highlight.js/lib/languages/vbscript'),
	"vbs": "vbscript",
	"verilog": () => import('highlight.js/lib/languages/verilog'),
	"v": "verilog",
	"sv": "verilog",
	"svh": "verilog",
	"vhdl": () => import('highlight.js/lib/languages/vhdl'),
	"vim": () => import('highlight.js/lib/languages/vim'),
	"wasm": () => import('highlight.js/lib/languages/wasm'),
	"wren": () => import('highlight.js/lib/languages/wren'),
	"x86asm": () => import('highlight.js/lib/languages/x86asm'),
	"xl": () => import('highlight.js/lib/languages/xl'),
	"tao": "xl",
	"xml": () => import('highlight.js/lib/languages/xml'),
	"html": "xml",
	"xhtml": "xml",
	"rss": "xml",
	"atom": "xml",
	"xjb": "xml",
	"xsd": "xml",
	"xsl": "xml",
	"plist": "xml",
	"wsf": "xml",
	"svg": "xml",
	"xquery": () => import('highlight.js/lib/languages/xquery'),
	"xpath": "xquery",
	"xq": "xquery",
	"xqm": "xquery",
	"yaml": () => import('highlight.js/lib/languages/yaml'),
	"yml": "yaml",
	"zephir": () => import('highlight.js/lib/languages/zephir'),
	"zep": "zephir",
};
//endregion