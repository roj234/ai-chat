/*
Language: JSON5-like
Description: 类似 JSON 但支持裸键、数字键、反引号字符串的格式。
*/

/**
 *
 * @param {import("highlight.js").HLJSApi} hljs
 * @return {import("highlight.js").Language}
 */
export default function json5(hljs) {
	const ATTRIBUTE = {
		className: 'attr',
		begin: /"(\\.|[^\\"\r\n])*"(?=\s*:)/,
		relevance: 1.01
	};
	const PUNCTUATION = {
		match: /[{}[\],:-]/,
		className: "punctuation",
		relevance: 0
	};
	const LITERALS = [
		"true",
		"false",
		"null",
		"Infinity",
		"NaN"
	];

	// 裸标识符键：foo:
	const BARE_ATTRIBUTE = {
		className: 'attr',
		begin: /[$A-Za-z_\u00A0-\uFFFF][$A-Za-z0-9_\u00A0-\uFFFF]*(?=\s*:)/,
		relevance: 1.01
	};

	// 数字键：123:
	const NUMERIC_ATTRIBUTE = {
		className: 'attr',
		begin: /(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?=\s*:)/,
		relevance: 1.01
	};

	// 反引号字符串内部的转义
	const ESCAPE = {
		className: 'escape',
		begin: /\\./s,
		relevance: 0
	};

	// 反引号字符串值
	const BACKTICK_STRING = {
		className: 'string',
		begin: /`/,
		end: /`/,
		contains: [ESCAPE],
		relevance: 1
	};

	return {
		name: 'Json5Like',
		aliases: ['json', 'jsonc', 'json5'],
		keywords: {
			literal: LITERALS
		},
		contains: [
			PUNCTUATION,
			ATTRIBUTE,
			//NUMERIC_ATTRIBUTE,
			BARE_ATTRIBUTE,
			BACKTICK_STRING,
			hljs.QUOTE_STRING_MODE,
			hljs.C_NUMBER_MODE,
			hljs.C_LINE_COMMENT_MODE,
			hljs.C_BLOCK_COMMENT_MODE
		]
	};
}
