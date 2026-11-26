import {getImmediateMessages, markMessageDirty} from "/src/database.js";
import {
	config,
	conversations,
	EditableMessageRoles,
	EVENT_BUS,
	MessageRoles,
	messages,
	selectedConversation
} from "/src/states.js";
import {registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {currentCombinedConfig} from "/src/presets.js";
import {ContentPart, registerToolset, toolScriptRegistry} from "/src/toolset.js";
import {JS_HOST_MODULES, JS_SANDBOX_MODULES} from "./agent/index.js";
import {debugSymbol} from "@roj234/shared";

// 插件API
window.Aint = Object.freeze({
	spec: 261125,
	plugins: Object.create(null),

	config,
	conversation: selectedConversation,
	messages,
	conversations,
	currentCombinedConfig,
	toolScriptRegistry,

	registerCodeBlockRenderer,
	registerSchemaMessageRole,

	registerToolset,
	markMessageDirty,
	ContentPart,
	EVENT_BUS,
	JS_HOST_MODULES,
	JS_SANDBOX_MODULES,

	registerCommand(name, desc, callback) {
		COMMAND_REGISTRY[name] = [callback, desc];
	},
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
				return true;
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

export const USER_PROMPT_ROLE = "userPrompt";
export const USER_PROMPT = debugSymbol("RealPrompt");

EditableMessageRoles.add(USER_PROMPT_ROLE);
MessageRoles[USER_PROMPT_ROLE] = {
	name: "提示块",
	compose(self, output) {
		if (self[USER_PROMPT]) {
			output.push({
				role: "user",
				content: self[USER_PROMPT]
			});
		} else {
			throw '找不到提示词，请重新调用SchemaRole';
		}
	},
	renderContent(self, chunks, index, isEditing, messages, defaultRenderContent) {
		if (self[USER_PROMPT]) {
			chunks.push({
				type: "think",
				think: {
					title: "展开完整提示",
					content: self[USER_PROMPT]
				}
			});
		} else {
			self.role = "user";
		}
		defaultRenderContent(self, chunks, self.content);
	}
}