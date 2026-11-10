
export const HLJS_LANGUAGE_RE = /highlight\.js\/es\/languages\/([^/]+)\.js$/;
/**
 * @typedef {{id: string, title: string, languages: string[]}} HljsLanguageFamily
 * @type {HljsLanguageFamily[]}
 */
export const HLJS_LANGUAGE_FAMILIES = [
	{
		id: 'web',
		languages: ['javascript', 'css', 'xml', 'graphql'],
	},
	{
		id: 'md',
		languages: ['markdown', 'diff', 'asciidoc', 'haxe', 'latex'],
	},
	{
		id: 'c',
		languages: ['c', 'cpp', 'objectivec', 'arduino', 'angelscript', 'vala', 'd'],
	},
	{
		id: 'template',
		languages: [
			'handlebars', 'twig', 'django', 'erb', 'haml',
			'dust', 'leaf', 'qml', 'vbscript-html', 'mojolicious',
			'dart' // 别管dart是不是模板语言了，我只是配平一下大小
		],
	},
	{
		id: 'jvm',
		languages: ['java', 'kotlin', 'scala', 'groovy', 'aspectj', 'ceylon', 'xl', 'processing', 'golo', 'smali', 'gradle'],
	},
	{
		id: 'dotnet',
		languages: ['csharp', 'fsharp', 'vbnet', 'vbscript', 'delphi', 'oxygene', 'basic', 'purebasic', 'monkey'],
	},
	{
		id: 'enterprise',
		title: 'ERP / 数据库业务 DSL',
		languages: ['1c', 'axapta', 'cal', 'cos'],
	},
	{
		id: 'systems',
		title: '现代系统级语言',
		languages: ['rust', 'go', 'swift', 'nim', 'crystal', 'pony', 'ada'],
	},
	{
		id: 'python',
		languages: ['python', 'python-repl', 'hy'],
	},
	{
		id: 'ruby',
		languages: ['ruby', 'puppet'],
	},
	{
		id: 'php',
		languages: ['php', 'php-template', 'zephir', 'lasso'],
	},
	{
		id: 'script',
		languages: ['perl', 'lua', 'moonscript', 'tcl', 'wren', 'parser3'],
	},
	{
		id: 'beam',
		title: 'Erlang / Elixir',
		languages: ['elixir', 'erlang', 'erlang-repl'],
	},
	{
		id: 'functional',
		languages: ['haskell', 'elm', 'ocaml', 'reasonml', 'sml'],
	},
	{
		id: 'lisp',
		languages: ['clojure', 'clojure-repl', 'lisp', 'scheme', 'prolog', 'mercury', 'coq', 'mizar', 'clean', 'flix'],
	},
	{
		id: 'shell',
		languages: ['bash', 'shell', 'dos', 'powershell', 'awk', 'autohotkey', 'autoit', 'applescript', 'taggerscript', 'vim'],
	},
	{
		id: 'buildscript',
		languages: ['makefile', 'cmake', 'nix', 'dockerfile', 'nsis'],
	},
	{
		id: 'config',
		languages: ['yaml', 'ini', 'properties', 'freedesktop', 'ldif'],
	},
	{
		id: 'devops',
		languages: ['nginx', 'apache', 'pf', 'dns', 'http', 'csp', 'accesslog', 'profile', 'crmsh', 'routeros', 'jboss-cli', 'dsconfig', 'roboconf'],
	},
	{
		id: 'sql',
		languages: ['sql', 'pgsql', 'n1ql', 'xquery', 'q', 'ruleslanguage'],
	},
	{
		id: 'CAS',
		languages: ['mathematica', 'maxima', 'matlab', 'scilab'],
	},
	{
		id: 'stats',
		languages: ['r', 'stata', 'sas', 'gams', 'gauss', 'stan', 'excel'],
	},
	{
		id: 'sci',
		title: '科学计算（Julia / Fortran）',
		languages: ['julia', 'julia-repl', 'fortran', 'irpf90'],
	},
	{
		id: 'asm',
		languages: ['x86asm', 'armasm', 'mipsasm', 'avrasm', 'llvm', 'wasm'],
	},
	{
		id: 'hardware',
		languages: ['verilog', 'vhdl', 'dts', 'glsl', 'openscad', 'gcode', 'tp', 'rsl', 'step21', 'rib'],
	},
	{
		id: 'game',
		languages: ['gml', 'sqf', 'isbl', 'lsl', 'mel', 'arcade', 'livecodeserver', 'hsp', 'inform7'],
	},
	{
		id: 'langspec',
		languages: ['abnf', 'ebnf', 'bnf', 'thrift', 'protobuf', 'capnproto', 'fix'],
	},
];
