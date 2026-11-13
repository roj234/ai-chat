import {getImmediateMessages, markMessageDirty} from "/src/database.js";
import {config, conversations, EVENT_BUS, messages, selectedConversation} from "/src/states.js";
import {registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {markCombinedPresetDirty, resolvePreset} from "/src/presets.js";
import {ContentPart, registerToolset, toolScriptRegistry} from "/src/toolset.js";

// 插件API
window.Aint = Object.freeze({
	spec: 261114,
	plugins: {},

	config,
	conversation: selectedConversation,
	messages,
	conversations,
	markMessageDirty,
	resolvePreset,
	markCombinedPresetDirty,

	registerToolset,
	toolScriptRegistry,
	ContentPart,

	registerCodeBlockRenderer,
	registerSchemaMessageRole,
	registerCommand(name, desc, callback) {
		COMMAND_REGISTRY[name] = [callback, desc];
	},

	EVENT_BUS,
});

/**
 * @param {string} id
 * @return {[
 * (conv: AiChat.Conversation, msgs: AiChat.Message[]) => void,
 * (conv: AiChat.Conversation, msgs: AiChat.Message[]) => void
 * ]}
 */
export const customRoleRegHelper = (id) => {
	const register = (conv, msgs) => {
		msgs ??= getImmediateMessages(conv);
		for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i];
			if (msg.id >= 0) {
				msgs.unshift({
					role: id,
					id: -1,
					hidden: true
				});
				break;
			}
			if (msg.role === id) break;
		}
	};
	const unregister = (conv, msgs) => {
		msgs ??= getImmediateMessages(conv);
		if (msgs) for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i];
			if (msg.id >= 0) break;
			if (msg.role === id) {
				msgs.splice(i, 1);
				break;
			}
		}
	};

	return [register, unregister];
}