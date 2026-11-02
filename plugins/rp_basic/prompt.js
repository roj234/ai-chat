import {showToast} from "/src/components/Toast.js";
import {config} from "/src/states.js";
import {debugSymbol} from "unconscious";
import {getTextContent} from "/src/utils/utils.js";
import {resolvePlaceholder} from "/src/utils/placeholder.js";
import {resolvePreset} from "/src/presets.js";

export const DEFAULT_USER_NAME = 'Tav'; // see Baldur's Gate 3

// 按照酒馆的命名，这叫宏
export const applyMacro = (prompt, ctx) => prompt.replaceAll(/\{\{(.+?)}}/g, (text, match) => {
	return match in ctx ? ctx[match] || '' : text;
});

const IS_SYSTEM = debugSymbol("InternalMessage");

/**
 * 预设处理器
 * @param {AiChat.DnD.MyPrompt[]} prompts
 * @param {AiChat.DnD.MyRegexp[]} regexps
 * @param {Record<string, string>} ctx
 * @param {OpenAI.Message[]} input
 * @param {AiChat.Conversation} conv
 * @return {OpenAI.Message[]}
 */
export const applyPreset = async ({prompts = [], regexps = []}, ctx, input, conv) => {
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

	if (input[0].role === "system") {
		first = applyMacro(input.shift().content, ctx);
	}

	/** @type {OpenAI.Message|undefined} */
	let message;
	for (;;) {
		message = input.at(-1);
		if (message && !message.content) input.length --;
		else break
	}

	/** @type {string} */
	let lastUserMessage = '';
	/** @type {OpenAI.Message[]} */
	let chatHistory = input;

	if (message?.role === "user") {
		lastUserMessage = getTextContent(message);
		// 酒馆并没有把最后一条消息去掉
		if (config.st_removeLastUserMessage)
			chatHistory = input.slice(0, input.length - 1);
	}

	for (let pid = 0; pid < prompts.length; pid++){
		const prompt = prompts[pid];
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
			let result = '';

			{
				let prev = 0, i;

				while ((i = content.indexOf('{{', prev)) >= 0) {
					result += content.slice(prev, i);

					const end = content.indexOf('}}', i + 2);
					if (end === -1) throw new DOMException(`preset[${pid}]中有未闭合的宏(`+i+')');

					const match = content.slice(i + 2, end).trim();
					if (match.includes('{{')) throw new DOMException(`preset[${pid}]中有未闭合的宏(`+i+')');

					prev = end + 2;
					if (content[prev] === '\n') prev++;

					if (match.startsWith("//")) continue;

					ok:
					if (match === "trim") needTrim = true;
					else if (match === "lastUserMessage") result += lastUserMessage;
					else if (match === "dialogueExamples") result += ctx.dialogueExamples?.length ? EXAMPLE_CHAT_LABEL + ctx.dialogueExamples.join(EXAMPLE_CHAT_LABEL) : '';
					else if (match in ctx) result += ctx[match] || '';
					else {
						const idx = match.indexOf("::");
						if (idx < 0) {
							const p = await resolvePlaceholder(match, await resolvePreset(conv), conv, 'rp');
							if (p !== undefined) {
								result += p;
								break ok;
							}
						}

						const cmd = match.slice(0, idx);
						if (cmd === "getvar") {
							const vname = match.slice(idx + 2);
							result += variables[vname]?.trim() ?? ("未定义的变量 "+vname+"\n");
							break ok;
						} else if (cmd === "random") {
							const choices = match.slice(idx + 2).split(",").map(s => s.trim()).filter(String);
							result += choices[0] || '';
							break ok;
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
				}
				result += content.slice(prev);
			}

			// 真的这么简单吗
			content = needTrim ? result.trim() : result;
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

	const activeRegexps = regexps.filter(item => item.enabled && item.stage !== 'render');
	if (activeRegexps.length) {
		for (let i = 0; i < messages.length; i++){
			let message = messages[i];
			if (!message[IS_SYSTEM])
			message.content = regexpReplace(activeRegexps, messages.length - 1 - i, message.content);
		}
	}

	const pp = config.st_postProcess;
	if (pp) {
		const offset = messages[0]?.role === "system" ? 0 : 1;
		if (pp === 2) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const item = messages[i];
				const prev = messages[i-1];
				if (i && (item.role === prev.role)) {
					messages.splice(i, 1);

					if (typeof prev.content === 'string' && typeof item.content === 'string') {
						prev.content += item.content;
						continue;
					}

					if (!Array.isArray(prev.content)) prev.content = [{ type: "text", text: prev.content }];
					if (!Array.isArray(item.content)) item.content = [{ type: "text", text: item.content }];
					prev.content.push(...item.content);
				}
			}
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const item = messages[i];
			if (item.role === "system" && i) {
				item.role = "user";
			}

			if (pp === 3) {
				if (!offset && !i) continue;
				item.role = (i + offset) % 2 ? "assistant" : "user";
			}
		}
	}

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



