import {config, selectedConversation} from "/src/states.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {setSystemPrompt} from "/src/skills.js";
import {makeSystemPrompt} from "/src/api-request.js";
import {defaultSystemPrompt} from "/src/settings.js";
import {kvListGet} from "/src/database.js";
import {showToast} from "/src/components/Toast.js";
import {$update} from "unconscious";
import {updateMessageUI} from "/src/components/MessageList.jsx";

COMMAND_REGISTRY["setprompt"] = [
	async (arg) => {
		let prompt = config.systemPrompt || defaultSystemPrompt;
		if (arg[0]) {
			const tmp = await kvListGet("preset", arg[0])?.systemPrompt;
			if (!tmp) {
				showToast("指定的预设没有系统提示词 "+arg[0], 'error');
				return;
			}
			prompt = tmp;
		}

		prompt = makeSystemPrompt(selectedConversation, prompt).prompt;
		setSystemPrompt(prompt);
		$update(updateMessageUI);
	},
	"将预设的系统提示词固化到当前对话",
];