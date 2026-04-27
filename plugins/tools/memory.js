import {PLACEHOLDERS, registerTools} from "/src/skills.js";
import {$state, $watch} from "unconscious";
import {getKV, setKV} from "/src/database.js";
import {onLoad} from "/src/plugin.js";

const systemPrompt = `<memory-management>
## Memory Management Instructions
1. **Identify Facts**: During the conversation, identify information that has long-term value (e.g., user's name, job, tech stack, likes/dislikes, past projects).
2. **Use the Tool**: When you encounter such information, call the \`manage_user_memory\` tool immediately.
   - Use \`add\` for new information.
   - Use \`update\` if the user changes their mind or provides new details on a known topic.
   - Use \`delete\` if the information is no longer true.
3. **Be Concise**: Keep the \`content\` of the memory short and factual.
4. **Silent Operation**: You can update memory in the background while responding to the user naturally.
5. **Don't remember identity**: ID number, phone number etc...

## Current Context (Memory)
Below are the facts you currently remember about this user. Use them to inform your responses:
<memory>
{{__MEMORIES__}}
</memory>

## Interaction Style
- If a memory is relevant to the current question, reference it (e.g., "Since you mentioned you prefer Python, I'll provide the code in that language.").
- If the user contradicts a stored memory, ask for clarification or update the memory.
</memory-management>`;

const memories = $state({});

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
const memoryTool = {
	name: "manage_user_memory",
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
	}
};

// TODO 也许不应该直接修改前缀，而是在新对话中生效？
PLACEHOLDERS["__MEMORIES__"] = () => JSON.stringify(memories.value);

registerTools("memory", "记忆工具", [memoryTool], {
	hidden: 'manual',
	systemPrompt
});

onLoad(async () => {
	memories.value = await getKV("memories") || {};
	$watch(memories, () => {
		setKV("memories", memories.value);
	}, false);
})