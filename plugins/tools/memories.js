import {getToolParameters, PLACEHOLDERS, registerTools} from "/src/skills.js";
import {$state, $update, $watch, unconscious} from "unconscious";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";
import {onConversationLoaded} from "/src/states.js";

const systemPrompt = `<memory-management>
## Memory policy
- Store long-term stable user facts when they are useful across conversations, such as preferences, tech stack, projects, role, or recurring constraints.
- Do not store sensitive identifiers such as ID numbers, phone numbers, access tokens, private keys, or passwords.
- Use add for new facts, update for changed facts, and delete for facts that are no longer true.
- Keep memory entries short and factual.

## Current memories
Below are the facts you currently remember about this user. Use them to inform your responses:
<memory>
{{__MEMORIES__}}
</memory>

## Interaction Style
- If a memory is relevant to the current question, reference it (e.g., "Since you mentioned you prefer Python, I'll provide the code in that language.").
- If the user contradicts a stored memory, ask for clarification or update the memory.
</memory-management>`;

/** @type {import('unconscious').Reactive<Record<string, string>>} */
const memories = $state();
const memoryChanged = $state();

const updateMemory_title = {
	'add': '新增',
	'update': '更新',
	'delete': '删除'
};

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
const UpdateMemory = {
	name: "UpdateMemory",
	description: "Store, update, or delete key facts about the user to maintain long-term memory across conversations.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["add", "update", "delete"],
				description: "The action to take: 'add' for new facts, 'update' for changing existing facts, 'delete' for removing outdated info."
			},
			id: {
				type: "string",
				description: "A unique identifier for the fact (e.g., 'user_coding_language'). Use a slug format."
			},
			content: {
				type: "string",
				description: "The actual fact to remember (e.g., 'User prefers Python over Java')."
			},
			/*term: {
				type: "string",
				enum: ["days", "months", "never"],
				description: "How long does this fact will be outdated and deleted."
			},*/
			/*category: {
				type: "string",
				enum: ["preference", "personal_info", "work", "hobby", "goal"],
				description: "Category of the information for better organization."
			}*/
		},
		required: ["action", "id", "content"]
	},

	script({action, id, content, term, category}, response) {
		switch (action) {
			case "add":
			case "update":
				memories[id] = content;
			break;
			case "delete":
				delete memories[id];
			break;
		}
		$update(memoryChanged);
		return "updated";
	},
	title(tc, ctx = {}) {
		const toolParameters = getToolParameters(ctx, tc);
		return updateMemory_title[toolParameters.action]+"记忆 "+toolParameters.id;
	}
};

onConversationLoaded(() => {
	// 对记忆的修改在切换对话（或者刷新）之后生效
	PLACEHOLDERS["__MEMORIES__"] = Object.entries(unconscious(memories) || {}).map(item => item.join(': ')).join('\n');
});

registerTools("Memories", "长期记忆管理工具", [UpdateMemory], {
	hidden: 'manual',
	systemPrompt
});

onLoad(() => {
	getKV("memories", memories);
	$watch(memoryChanged, () => {
		setKV("memories", unconscious(memories));
	}, false);
})