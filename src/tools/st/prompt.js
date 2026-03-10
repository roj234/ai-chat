
import {showToast} from "../../components/Toast.js";
import {config} from "../../states.js";
import {debugSymbol} from "unconscious";

export const DEFAULT_USER_NAME = 'Tav'; // see Baldur's Gate 3

// 按照酒馆的命名，这叫宏
export function applyMacro(prompt, ctx = {}) {
	return prompt.replaceAll(/\{\{(.+?)}}/g, (text, match) => {
		return ctx[match] || text;
	});
}

const COMPILED = debugSymbol("REGEXP");

/**
 * 预设处理器
 * @param {AiChat.DnD.MyPrompt[]} prompts
 * @param {AiChat.DnD.MyRegexp[]} regexps
 * @param {Record<string, string>} ctx
 * @param {OpenAI.Message[]} jsonMessages
 * @return {OpenAI.Message[]}
 */
export function applyPreset({prompts, regexps}, ctx, jsonMessages) {
	let first = '';
	/** @type {OpenAI.Message[]} */
	const messages = [{
		role: "system",
		content: ""
	}];
	const variables = {};
	let length = 0;
	/** @type {OpenAI.Message} */
	let currentMessage;

	if (jsonMessages[0].role === "system") {
		first = jsonMessages.shift().content;
	}

	let message ;
	for (;;) {
		message = jsonMessages.at(-1);
		if (!message.content) jsonMessages.length --;
		else break
	}

	/** @type {string} */
	let lastUserMessage = '';
	/** @type {OpenAI.Message[]} */
	let chatHistory;

	if (message.role === "user") {
		lastUserMessage = message.content;
		// 酒馆并没有把最后一条消息去掉
		chatHistory = jsonMessages.slice(0, jsonMessages.length-1);
	} else {
		chatHistory = jsonMessages;
	}

	for (const prompt of prompts) {
		let {content, enabled, attr, role} = prompt;
		if (!enabled) continue;

		if (attr === "marker") {
			if (content === "dialogueExamples") {
				if (ctx.dialogueExamples)
					messages.push({
						role: "system",
						content: "\n\n[Example Chat]\n\n"+ctx.dialogueExamples.join("\n\n[Example Chat]\n\n")
					});
				continue;
			}
			if (content === "chatHistory") {
				messages.push(...chatHistory);
				continue;
			}

			const cnt = applyMacro(ctx[content] || '', ctx).trim();
			if (cnt) {
				if (currentMessage) {
					if (currentMessage.role !== role)
						messages.push(currentMessage = {
							role,
							content: cnt
						});
					else {
						currentMessage.content += "\n\n"+cnt;
					}
				}
				else first += "\n\n"+cnt;
			}
		} else {
			let needTrim = false;
			content = content.replaceAll(/\{\{(.+?)}}/gs, (_, match) => {
				if (!match.startsWith("//")) {
					if (match === "trim") {
						if (!needTrim) {
							needTrim = true;
							return "";
						}
					}

					if (match === "lastUserMessage") return lastUserMessage;
					if (ctx[match]) return ctx[match];

					const idx = match.indexOf("::");
					const cmd = match.substring(0, idx);
					if (cmd === "getvar") {
						const vname = match.substring(idx + 2);
						return variables[vname]?.trim() ?? ("未定义的变量 "+vname+"\n");
					}

					const idx2 = match.indexOf("::", idx + 2);
					const name = match.substring(idx + 2, idx2);
					let value = match.substring(idx2 + 2);
					//if (value.startsWith("\n")) value = value.trim();

					if (cmd === "setvar") {
						variables[name] = value;
					} else if (cmd === "addvar") {
						variables[name] = (variables[name] || "") + value;
					} else {
						showToast("暂不支持指令: "+match, "error");
					}
				}
				return "";
			});
			// 真的这么简单吗
			if (needTrim) content = content.trim();
			if (!content) continue;
			length += content.length;

			if (attr === "first") {
				first += content;
			} else {
				messages.push(currentMessage = {
					role,
					content
				});
			}
		}
	}

	if (first) {
		messages[0].content = first;
	} else {
		messages.shift();
	}

	if (config.st_postProcess) {
		const offset = message[0]?.role === "system" ? 0 : 1;
		for (let i = 0; i < messages.length; i++){
			const item = messages[i];
			switch (config.st_postProcess) {
				case 1: {
					if (item.role === "system" && i) {
						item.role = "user";
					}
				}
					break;
				case 2: {
					if (!offset && !i) continue;
					item.role = (i + offset) % 2 ? "assistant" : "user";
				}
					break;
			}
		}
	}

	if (regexps.length) {
		for (let i = 0; i < messages.length; i++){
			let message = messages[i];
			let content = message.content;

			for (const regexp of regexps) {
				if (!regexp.enabled || regexp.stage === 'render' || i < regexp.depth[0] || (regexp.depth[1] !== 50 && i > regexp.depth[1])) continue;

				/**
				 * @type {RegExp}
				 */
				let re = regexp[COMPILED];
				if (!re) {
					const str = regexp.search;
					if (str[0] === '/') {
						const idx = str.lastIndexOf('/');
						re = new RegExp(str.substring(1, idx), str.substring(idx + 1));
					} else {
						re = new RegExp(str);
					}
					regexp[COMPILED] = re;
				}

				content = replaceString(content, re, regexp.replace);
				//console.log("regexp", re, regexp.replace);
			}

			message.content = content;
		}
	}

	return messages;
}


export function createDefaultCtx(char) {
	return {
		char: char.name,
		user: config.st_username || DEFAULT_USER_NAME
	}
}

/**
 * 按照酒馆的命名，这叫故事字符串
 * @param {AiChat.DnD.MyCharacter} char
 * @param {string} lbBefore
 * @param {string} lbAfter
 * @return {string|OpenAI.Message[]}
 */
export function makeStory(char, lbBefore = "", lbAfter = "") {
	let story = char.systemPrompt || `Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.`;

	if (lbBefore) story += /*"\n\n"+*/lbBefore;
	if (config.st_userdesc) story += "\n\n"+config.st_userdesc;
	if (char.description) story += "\n\n"+char.description;
	if (char.personality) story += "\n\n"+char.personality;
	if (char.scenario) story += "\n\n"+char.scenario;
	if (lbAfter) story += /*"\n\n"+*/lbAfter;
	if (char.dialogueExamples) story += "\n\n[Example Chat]\n\n"+char.dialogueExamples.join("\n\n[Example Chat]\n\n");

	return applyMacro(story + `\n\n[Start a new Chat]`, createDefaultCtx(char)).trim();
}

/**
 * 将字符串中匹配正则表达式的部分替换为指定的字符串（支持 $1, $& 等占位符）
 * @param {string} str - 原始字符串
 * @param {RegExp} re - 正则表达式（可能带有 g 标志，也可能不带）
 * @param {string} replacement - 替换字符串，可包含以下占位符：
 *   $$  → "$"
 *   $&  → 本次匹配到的子串
 *   $`  → 匹配子串左侧的文本
 *   $'  → 匹配子串右侧的文本
 *   $n  → 第 n 个捕获组（1 起始）
 *   其他 $x 原样保留
 * @returns {string} 替换后的新字符串
 */
function replaceString(str, re, replacement) {
	re.lastIndex = 0;

	// 非全局模式：只处理第一个匹配
	if (!re.global) {
		const match = re.exec(str);
		if (!match) return str;

		// 拼接：左侧 + 替换后的文本 + 右侧
		return (
			str.slice(0, match.index) +
			getReplacement(replacement, match, str) +
			str.slice(match.index + match[0].length)
		);
	}

	// 全局模式：循环处理所有匹配
	let result = '';
	let lastIndex = 0;
	let match;

	while ((match = re.exec(str)) !== null) {
		// 添加匹配前的部分
		result += str.slice(lastIndex, match.index);
		// 添加替换后的文本
		result += getReplacement(replacement, match, str);
		// 更新指针
		lastIndex = match.index + match[0].length;

		// 防止零长度匹配导致死循环
		if (match[0].length === 0) {
			re.lastIndex++;
		}
	}

	// 添加剩余部分
	result += str.slice(lastIndex);
	return result;
}

/**
 * 根据匹配信息生成最终的替换字符串
 * @param {string} replacement - 原始替换模板
 * @param {RegExpExecArray} match - exec 返回的匹配数组
 * @param {string} str - 原始字符串（用于 $` 和 $'）
 * @returns {string}
 */
function getReplacement(replacement, match, str) {
	const matched = match[0];
	const before = str.slice(0, match.index);
	const after = str.slice(match.index + matched.length);

	// 替换 $$ 和 $ 开头的占位符
	return replacement.replace(/\$(\$|&|`|'|\d+)/g, (m, token) => {
		switch (token) {
			case '$': return '$';                // $$
			case '&': return matched;            // $&
			case '`': return before;             // $`
			case "'": return after;              // $'
			default:                              // $n
				const n = parseInt(token, 10);
				return n > 0 && n < match.length ? match[n] : m;
		}
	});
}