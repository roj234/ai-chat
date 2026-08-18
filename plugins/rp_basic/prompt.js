import {showToast} from "/src/components/Toast.js";
import {config} from "/src/states.js";
import {debugSymbol} from "unconscious";

export const DEFAULT_USER_NAME = 'Tav'; // see Baldur's Gate 3

// 按照酒馆的命名，这叫宏
export const applyMacro = (prompt, ctx) => prompt.replaceAll(/\{\{(.+?)}}/g, (text, match) => {
	return ctx[match] || text;
});

const IS_SYSTEM = debugSymbol("InternalMessage");

/**
 * 预设处理器
 * @param {AiChat.DnD.MyPrompt[]} prompts
 * @param {AiChat.DnD.MyRegexp[]} regexps
 * @param {Record<string, string>} ctx
 * @param {OpenAI.Message[]} jsonMessages
 * @param {boolean} prefill
 * @return {OpenAI.Message[]}
 */
export const applyPreset = ({prompts = [], regexps = []}, ctx, jsonMessages, prefill) => {
	let first = '';
	/** @type {OpenAI.Message[]} */
	const messages = [{
		role: "system",
		content: "",
		[IS_SYSTEM]: true
	}];
	const variables = {};
	let length = 0;
	/** @type {OpenAI.Message} */
	let currentMessage;

	if (jsonMessages[0].role === "system") {
		first = applyMacro(jsonMessages.shift().content, ctx);
	}

	let prefillMessage= prefill && jsonMessages.pop();

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
		chatHistory = jsonMessages;
		if (config.st_removeLastUserMessage)
			chatHistory = jsonMessages.slice(0, jsonMessages.length-1);
	} else {
		chatHistory = jsonMessages;
	}

	for (const prompt of prompts) {
		let {content, enabled, attr, role} = prompt;
		if (!enabled) continue;

		content = applyMacro(content, ctx);
		if (attr === "marker") {
			if (content === "chatHistory") {
				messages.push(...chatHistory);
				continue;
			}

			let raw = ctx[content] || '';
			if (content === "dialogueExamples" && ctx.dialogueExamples?.length)
				raw = EXAMPLE_CHAT_LABEL + ctx.dialogueExamples.join(EXAMPLE_CHAT_LABEL);
			if (content === "lastUserMessage")
				raw = lastUserMessage;

			const cnt = applyMacro(raw, ctx).trim();
			if (cnt) {
				if (currentMessage) {
					if (currentMessage.role !== role)
						messages.push(currentMessage = {
							role,
							content: cnt,
							[IS_SYSTEM]: true
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
						needTrim = true;
						return "";
					}

					if (match === "lastUserMessage") return lastUserMessage;
					if (ctx[match]) return ctx[match];

					const idx = match.indexOf("::");
					const cmd = match.slice(0, idx);
					if (cmd === "getvar") {
						const vname = match.slice(idx + 2);
						return variables[vname]?.trim() ?? ("未定义的变量 "+vname+"\n");
					}
					if (cmd === "random") {
						const choices = match.slice(idx + 2).split(",").map(s => s.trim()).filter(String);
						return choices[0] || '';
					}

					const idx2 = match.indexOf("::", idx + 2);
					const name = match.slice(idx + 2, idx2);
					let value = match.slice(idx2 + 2);
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
					content,
					[IS_SYSTEM]: true
				});
			}
		}
	}

	if (first) {
		messages[0].content = first;
	} else {
		messages.shift();
	}

	const pp = config.st_postProcess;
	if (pp) {
		const offset = message[0]?.role === "system" ? 0 : 1;
		for (let i = 0; i < messages.length; i++) {
			const item = messages[i];
			if (item.role === "system" && i) {
				item.role = "user";
			}

			if (pp === 2) {
				if (!offset && !i) continue;
				item.role = (i + offset) % 2 ? "assistant" : "user";
			}
		}
	}

	const activeRegexps = regexps.filter(item => item.enabled && item.stage !== 'render');
	if (activeRegexps.length) {
		for (let i = 0; i < messages.length; i++){
			let message = messages[i];
			if (!message[IS_SYSTEM])
			message.content = regexpReplace(activeRegexps, messages.length - 1 - i, message.content);
		}
	}

	if (prefillMessage) messages.push(prefillMessage);
	return messages;
};


// dialogueExamples and chatHistory are specially handled in applyPreset().
export const createSimpleMacroContext = char => ({
	//...char,
	char: char.char || char.name,
	user: char.user || config.nickname || DEFAULT_USER_NAME,
	personaDescription: char.personaDescription || config.st_userdesc,
	description: char.description,
	personality: char.personality,
	scenario: char.scenario,
	systemPrompt: char.systemPrompt,
});

export const DEFAULT_SYSTEM_PROMPT = `Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.`;
const EXAMPLE_CHAT_LABEL = "\n\n[Example Chat]\n\n";
const START_CHAT_LABEL = `\n\n[Start a new Chat]`;

/**
 * 按照酒馆的命名，这叫故事字符串
 * @param {AiChat.DnD.MyCharacter & Record<string, string>} char
 * @param {string} worldInfoBefore
 * @param {string} worldInfoAfter
 * @return {string|OpenAI.Message[]}
 */
export const makeStory = (char, worldInfoBefore = "", worldInfoAfter = "") => {
	let story = char.systemPrompt || DEFAULT_SYSTEM_PROMPT;

	if (worldInfoBefore) story += worldInfoBefore;
	let tmp;
	if ((tmp = char.personaDescription || config.st_userdesc)) story += "\n\n"+tmp;
	//story += "\n\n"+char.name+":";
	if ((tmp = char.description)) story += "\n\n"+tmp;
	if ((tmp = char.personality)) story += "\n\n"+tmp;
	if ((tmp = char.scenario)) story += "\n\n"+tmp;
	if (worldInfoAfter) story += worldInfoAfter;
	if (char.dialogueExamples?.length) story += EXAMPLE_CHAT_LABEL+char.dialogueExamples.join(EXAMPLE_CHAT_LABEL);

	return applyMacro(story + START_CHAT_LABEL, char).trim();
};

/**
 * @param {AiChat.DnD.MyRegexp[]} regexps
 * @param {string} content
 * @param {number} depth
 */
export const applyRenderReplace = ({regexps = []}, content, depth) => {
	const activeRegexps = regexps.filter(item => item.enabled && item.stage !== 'prompt');
	return activeRegexps.length ? regexpReplace(activeRegexps, depth, content) : content;
};

const COMPILED = debugSymbol("Pattern");

/**
 * @param {AiChat.DnD.MyRegexp[]} regexps
 * @param {number} depth
 * @param {string} content
 */
const regexpReplace = (regexps, depth, content) => {
	for (const regexp of regexps) {
		if (depth < regexp.depth[0] || (regexp.depth[1] !== 50 && depth > regexp.depth[1])) continue;

		/**
		 * @type {RegExp}
		 */
		let re = regexp[COMPILED];
		if (!re) {
			const str = regexp.search;
			if (str[0] === '/') {
				const idx = str.lastIndexOf('/');
				re = new RegExp(str.slice(1, idx), str.slice(idx + 1));
			} else {
				re = new RegExp(str);
			}
			regexp[COMPILED] = re;
		}

		content = content.replace(re, regexp.replace);
	}
	return content;
};



