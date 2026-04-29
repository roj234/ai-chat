import {showToast} from "/src/components/Toast.js";
import {randomId} from "./STPresetPanel.jsx";

/**
 * 把 \r 去掉
 * @template T
 * @param {T} inp
 * @return {T}
 */
export function normalizeCRLF(inp) {
	return JSON.parse(JSON.stringify(inp, (key, value) => {
		if (typeof value !== "string") return value;
		return value.trim().replaceAll('\r\n', '\n').replaceAll('\r', '\n');
	}));
}


//region 酒馆格式转换
const _presetRemap = {
	charDescription: "description",
	charPersonality: "personality"
};

/**
 *
 * @param {AiChat.DnD.SillyTavernPreset} inp
 * @param {string} fileName
 * @return {AiChat.DnD.MyPreset}
 */
export function convertSTPreset(inp, fileName) {
	/** @type {AiChat.DnD.MyPreset} */
	const out = {
		name: fileName,
		time: Date.now(),
		prompts: [],
		regexps: []
	};

	const by_index = {};
	inp.prompts.forEach(item => by_index[item.identifier] = item);

	for (let {identifier, enabled} of inp.prompt_order[0].order) {
		let {name, role, content, system_prompt, marker} = by_index[identifier] || {};
		if (!name) {
			showToast("找不到内置对象："+identifier, "error", 0);
			continue;
		}
		if (!content) {
			if (!marker) continue;
			content = _presetRemap[identifier] || identifier;
		}

		out.prompts.push({
			name,
			role,
			content,
			attr: marker ? "marker" : system_prompt ? "first" : undefined,
			enabled,
		});
	}

	const index = fileName.lastIndexOf(".");
	if (index >= 0) fileName = fileName.substring(0, index);

	const regexScripts = inp.extensions?.regex_scripts;
	if (Array.isArray(regexScripts) && regexScripts[0]) {
		out.regexps = regexScripts.map(item => {
			return {
				name: item.scriptName,
				search: item.findRegex,
				replace: item.replaceString,
				enabled: !item.disabled,
				stage: item.markdownOnly ? 'render' : item.promptOnly ? 'prompt' : 'all',
				depth: [item.minDepth || 0, item.maxDepth || 50],
			}
		});
	}

	return out;
}

const ROLE = ['system', 'user', 'assistant'];

/**
 *
 * @param {AiChat.DnD.STLorebookEntry[]} entries
 * @return {AiChat.DnD.MyLorebookPage[]}
 */
function convertSTLorebookEntry(entries) {
	if (entries[0]?.displayIndex) {
		entries.sort((a, b) => a.displayIndex - b.displayIndex);
	}

	return entries.map(item => {
		/**
		 *
		 * @type {Partial<AiChat.DnD.MyLorebookPage>}
		 */
		const obj = {
			enabled: item.enabled,
			content: item.content,
			constant: item.constant,
			triggers: item.keys.map(s => s.toLowerCase().trim()),
			window: (item.sticky || 0) + 1,
			id: randomId(),
		};

		obj.name = item.name || item.comment;
		if (item.name) obj.comment = item.comment;

		switch (item.position) {
			case "before_char":
				obj.position = "worldInfoBefore";
				break;
			case "":
			default:
			case "after_char":
				obj.position = "worldInfoAfter";
				break;
			case 4:
				obj.position = 'depth';
				obj.role = ROLE[item.role];
				obj.depth = item.depth;
				break;
		}

		let recursionMode;
		if (item.extensions?.excludeRecursion) {
			recursionMode = false;
		} else {
			if (item.excludeRecursion) {
				recursionMode = false;
			} else if (item.preventRecursion) {
				recursionMode = 'stop';
			} else if (item.delayUntilRecursion) {
				recursionMode = 'only';
			} else {
				recursionMode = true;
			}
		}
		obj.recursion = recursionMode;

		if (item.extensions?.depth) {
			obj.position = 'depth';
			obj.role = null; // any
			obj.depth = item.extensions?.depth;
		}

		return obj;
	});
}

/**
 *
 * @param {{entries: Record<string, AiChat.DnD.STLorebookEntry>}} json
 * @param {string} fileName
 * @return {AiChat.DnD.MyLorebook}
 */
export function convertSTLorebook(json, fileName) {
	return {
		name: fileName,
		pages: convertSTLorebookEntry(Object.values(json.entries))
	}
}

/**
 *
 * @param {AiChat.DnD.SillyTavernCharacterCard} json
 * @return {AiChat.DnD.MyCharacter}
 */
export function convertSTCharacter(json) {
	let inp = json.data;

	/**
	 *
	 * @type {MyCharacter}
	 */
	const out = {
		name: "unknown"
	};

	for (const name of [
		"name", "system_prompt", "description",
		"creator", "creator_notes", "tags",
		// legacy field
		"personality", "scenario",
	]) {
		if (inp[name])
			out[name.replace(/_([a-z])/g, (_, match) => match.toUpperCase())] = inp[name];
	}

	if (inp.character_version) {
		out.version = inp.character_version;
	}

	if (inp.create_date) {
		out.time = inp.create_date;
	}

	if (inp.mes_example) {
		out.dialogueExamples = inp.mes_example.split("<START>").map(item => item.trim()).filter(item => item);
	}

	if (inp.first_mes) {
		const alternateGreetings = inp.alternate_greetings || [];
		out.greetings = [inp.first_mes, ...alternateGreetings];
	}

	if (inp.character_book?.entries.length) {
		out.lorebook = convertSTLorebookEntry(inp.character_book.entries);
	}

	const messages = [];

	if (inp.extensions?.depth_prompt?.prompt) {
		messages.push({
			name: "depth_prompt",
			content: inp.extensions.depth_prompt.prompt,
			depth: inp.extensions.depth_prompt.depth,
		});
	}

	if (inp.post_history_instructions) {
		messages.push({
			name: "post_history",
			content: inp.post_history_instructions,
			depth: 0,
		});
	}

	if (messages.length) out.autoMessages = messages;

	return out;
}
//endregion

/**
 * UTF-8 byte string (atob结果) 转字符串
 * @param {string} view
 * @return {string}
 */
export function utf2str(view) {
	let i = 0;
	const len = view.length;

	var out = "";

	while (i < len) {
		var c = view.charCodeAt(i++);
		switch (c >> 4) {
			case 0: case 1: case 2: case 3:
			case 4: case 5: case 6: case 7:
				out += String.fromCharCode(c);
				break;
			case 12:
			case 13:
				out += String.fromCharCode(((c & 0x1F) << 6) |
					(view.charCodeAt(i++) & 0x3F));
				break;
			case 14:
				out += String.fromCharCode(((c & 0x0F) << 12) |
					((view.charCodeAt(i++) & 0x3F) << 6) |
					(view.charCodeAt(i++) & 0x3F));
				break;
		}
	}
	return out;
}