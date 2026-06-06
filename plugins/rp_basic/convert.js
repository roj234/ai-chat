/**
 * 把 \r 去掉
 * @template T
 * @param {T} inp
 * @return {T}
 */
export const normalizeCRLF = inp => JSON.parse(JSON.stringify(inp, (key, value) => {
	if (typeof value !== "string") return value;
	return value.trim().replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}));

const stripComments = s => s.replaceAll(/{{\/\/[^}]*}}/g, "");

//region 酒馆格式转换
const _presetRemap = {
	charDescription: "description",
	charPersonality: "personality"
};

const convertRegexScripts = (inp, out) => {
	const regexScripts = inp.regexScripts;
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
};

const ROLE = ['system', 'user', 'assistant'];

/**
 * @template T
 * @param {T} item
 * @return {T}
 */
const convertKeys = item => {
	const {extensions, ...rest} = item;
	const out = {};

	const conv = (o) => {
		for (const [key, v] of Object.entries(o)) {
			out[key.replace(/_([a-z])/g, (_, match) => match.toUpperCase())] = v;
		}
	};

	if (extensions) {
		conv(extensions);
	}
	conv(rest);
	return out;
};

/**
 *
 * @param {AiChat.DnD.SillyTavernPreset} inp
 * @param {string} fileName
 * @param {function(string): void} error
 * @return {AiChat.DnD.MyPreset}
 */
export const convertSTPreset = (inp, fileName, error = console.error) => {
	inp = convertKeys(inp);

	const end = fileName.lastIndexOf('.');
	/** @type {AiChat.DnD.MyPreset} */
	const out = {
		name: fileName.slice(0, end < 0 ? fileName.length : end),
		time: Date.now(),
		prompts: [],
		regexps: []
	};

	const by_index = {};
	inp.prompts.forEach(item => by_index[item.identifier] = item);

	const orders = inp.promptOrder.find(item => item.character_id === 100001) || inp.promptOrder[0];
	for (let {identifier, enabled} of orders.order) {
		let {name, role, content, system_prompt, marker} = by_index[identifier] || {};
		if (!name) {
			error("找不到内置对象："+identifier);
			continue;
		}
		if (!content) {
			if (!marker) continue;
			content = _presetRemap[identifier] || identifier;
		}
		content = content.replaceAll("<user>", "{{user}}").replaceAll("<char>", "{{char}}");

		out.prompts.push({
			name,
			role,
			content,
			attr: marker ? "marker" : system_prompt ? "first" : undefined,
			enabled,
		});
	}

	const index = fileName.lastIndexOf(".");
	if (index >= 0) fileName = fileName.slice(0, index);
	convertRegexScripts(inp, out);

	return out;
};

/**
 *
 * @param {AiChat.DnD.STLorebookEntry[]} entries
 * @return {AiChat.DnD.MyLorebookPage[]}
 */
const convertSTLorebookEntry = entries => {
	entries = entries.filter(item => item).map(item => {
		if (typeof item === "string") {
			return {
				enabled: true,
				content: item,
				constant: true
			}
		}
		return convertKeys(item);
	});

	if (entries[0]?.displayIndex) {
		entries.sort((a, b) => a.displayIndex - b.displayIndex);
	}

	return entries.map(item => {
		/**
		 *
		 * @type {Partial<AiChat.DnD.MyLorebookPage>}
		 */
		const obj = {
			enabled: item.enabled || (false === item.disabled),
			content: stripComments(item.content),
			constant: item.constant,
			triggers: (item.keys || item.key)?.map(s => stripComments(s.toLowerCase().trim())).filter(s => s) || [],
			window: (item.sticky || item.scanDepth || 4)
		};

		obj.name = item.name || item.comment;
		if (item.name) obj.comment = item.comment;
		if (item.useProbability) obj.probability = item.probability;

		switch (item.position) {
			case 0:
			case "before_char":
				obj.position = "worldInfoBefore";
				break;
			case "":
			case 1:
			case "after_char":
				obj.position = "worldInfoAfter";
				break;
			default:
				if (null == item.depth) {
					obj.position = "worldInfoAfter";
					break;
				}
			// noinspection FallThroughInSwitchStatementJS
			case 4:
				obj.position = 'depth';
				obj.role = ROLE[item.role];
				obj.depth = item.depth;
				break;
		}

		let recursionMode;
		if (item.excludeRecursion) {
			recursionMode = false;
		} else if (item.preventRecursion) {
			recursionMode = 'stop';
		} else if (item.delayUntilRecursion) {
			recursionMode = 'only';
		} else {
			recursionMode = true;
		}
		obj.recursion = recursionMode;
		return obj;
	});
};

/**
 *
 * @param {{entries: Record<string, AiChat.DnD.STLorebookEntry>}} json
 * @param {string} fileName
 * @return {AiChat.DnD.MyLorebook}
 */
export const convertSTLorebook = (json, fileName) => ({
	name: fileName,
	pages: convertSTLorebookEntry(Object.values(json.entries))
});

/**
 *
 * @param {AiChat.DnD.SillyTavernCharacterCard} json
 * @return {AiChat.DnD.MyCharacter}
 */
export const convertSTCharacter = json => {
	let inp = convertKeys(json.data);

	/**
	 *
	 * @type {MyCharacter}
	 */
	const out = {
		name: "unknown"
	};

	for (const name of [
		"name", "systemPrompt", "description",
		"creator", "creatorNotes", "tags",
		// legacy field
		"personality", "scenario",
	]) {
		if (inp[name]) out[name] = inp[name];
	}

	const {
		characterVersion, modificationDate, creationDate,
		mesExample, firstMes, alternateGreetings = [],
		characterBook, depthPrompt, postHistoryInstructions,
		chub, charArchive
	} = inp;

	if (!Array.isArray(out.tags)) out.tags = [out.tags];
	if (characterVersion) out.version = characterVersion;
	if (modificationDate) out.time = modificationDate;
	if (creationDate) out.createTime = creationDate;

	if (mesExample) {
		out.dialogueExamples = mesExample.split("<START>").map(item => item.trim()).filter(item => item);
	}

	if (firstMes) out.greetings = [firstMes, ...alternateGreetings];

	if (characterBook?.entries.length) {
		out.lorebook = convertSTLorebookEntry(characterBook.entries);
	}

	const messages = [];

	if (depthPrompt?.prompt) {
		messages.push({
			name: "depth_prompt",
			content: depthPrompt.prompt,
			depth: depthPrompt.depth,
		});
	}

	if (postHistoryInstructions) {
		messages.push({
			name: "post_history",
			content: postHistoryInstructions,
			depth: 0,
		});
	}

	if (chub) {
		out.extensions = {
			chub: {
				id: chub.id,
				repo: chub.full_path
			}
		}
	}
	if (charArchive && !out.time) {
		out.time = new Date(charArchive.added).getTime();
		out.createTime = new Date(charArchive.created).getTime();
	}

	if (messages.length) out.autoMessages = messages;

	convertRegexScripts(inp, out);

	return out;
};
//endregion
