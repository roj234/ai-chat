import {config, selectedConversation, updateMessageUI} from "/src/states.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {setSystemPrompt} from "/src/toolset.js";
import {buildSystemPrompt} from "/src/api-request.js";
import {defaultSystemPrompt} from "/src/settings.js";
import {kvListGet} from "/src/database.js";
import {showToast} from "/src/components/Toast.js";
import {$update} from "unconscious";

COMMAND_REGISTRY["freezeprompt"] = [
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

		[prompt] = await buildSystemPrompt(config, selectedConversation, prompt);
		setSystemPrompt(prompt);
		$update(updateMessageUI);
	},
	"将当前系统提示词固化到对话，不再因为变量的变化（如日期、技能等）而导致缓存失效",
];