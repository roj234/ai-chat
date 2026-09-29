import {getMessages} from "/src/database.js";
import {getToolParameters} from "/src/toolset.js";
import {EVENT_BUS} from "/src/states.js";
import {debugSymbol} from "unconscious";


const NEWLY_CREATED_FILES = debugSymbol("WrittenFiles");

export const FileChangerNames = new Set(['Read', 'Write', 'Edit', 'Patch', 'CopyMove']);

/**
 * @param {AiChat.Conversation} conv
 * @param {string} [path]
 * @return {Promise<*>}
 */
export async function getChangeableFiles(conv, path) {
	let files = conv[NEWLY_CREATED_FILES];
	if (!files) {
		if (path) return;

		files = conv[NEWLY_CREATED_FILES] = new Set;
		for (const message of await getMessages(conv)) {
			const resp = message.tool_responses;
			if (resp) {
				for (let i = 0; i < resp.length; i++) {
					const k = message.tool_calls[i], v = resp[i];
					const name = k.function.name;
					if (v.success) {
						if (FileChangerNames.has(name)) {
							const tp = getToolParameters(v, k, true);
							if (tp) files.add(name === 'Copy' ? tp.dest : tp.path);
						}
					}
				}
			}
		}
	} else if (path) {
		files.add(path);
	}
	return files;
}

EVENT_BUS.on('switchBranch', (conv) => {delete conv[NEWLY_CREATED_FILES];});