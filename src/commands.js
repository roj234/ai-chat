import {showToast} from "./components/Toast.js";
import {beginConversation, selectedConversation} from "./states.js";
import {updateConversation} from "./database.js";
import {loadPreset} from "./components/PresetDropdown.jsx";
import {unconscious} from "unconscious";
import {tokenize} from "unconscious/common/StringTokenizer.js";

/**
 * 指令处理器定义
 * @typedef {[function(string[], Record<string, string>): Promise<void>|void, string?]} CommandHandler
 */

/** @type {Record<string, CommandHandler>} */
export const COMMAND_REGISTRY = {
	preset: [
		(...names) => {
			if (!names.length) throw new Error("请指定预设名称");
			for (const name of names) {
				if (loadPreset(name)) showToast(`已加载预设: ${name}`, 'success');
			}
		},
		"加载预设: /preset <name>...",
	],
	new: [
		() => beginConversation(),
		"开启新对话",
	],
	title: [
		async (args) => {
			const conversation = unconscious(selectedConversation);
			if (!conversation) throw new Error("未选中对话");

			const newTitle = args.join(" "); // 支持带空格的标题
			if (!newTitle) throw new Error("标题不能为空");

			selectedConversation.title = newTitle;
			await updateConversation(conversation);
			showToast("标题已更新", "success");
		},
		"修改对话标题: /title <new_title>",
	],
	help: [
		(args, params, element) => {
			const helpText = Object.entries(COMMAND_REGISTRY)
				.map(([name, [_, desc]]) => `/${name.padEnd(10)} - ${desc}`)
				.join('\n');

			// 直接在输入框显示帮助，或者弹窗
			element.value = `/### 指令列表 ###\n${helpText}`;
			element.dispatchEvent(new InputEvent("input"));
		},
		"显示帮助"
	]
};

/**
 * 解析指令字符串
 * 示例: /title "My Room" category:work
 * 返回: { command: "title", args: ["My Room"], params: { category: "work" } }
 */
const parseCommand = text => {
	const parts = tokenize(text.substring(1));
	const command = parts.shift().toLowerCase();
	const args = [];
	const params = {};

	// 简单的正则处理：支持 key:value 或直接的参数
	parts.forEach(part => {
		if (part.includes(':')) {
			const [k, v] = part.split(':');
			params[k] = v;
		} else {
			args.push(part.replace(/^"|"$/g, '')); // 去掉引号
		}
	});

	return { command, args, params };
};

/**
 * 主入口函数
 * @param {import("unconscious").Reactive<string>} inputText
 * @returns {Promise<boolean>} 是否拦截了输入
 */
export const handleCommand = async inputText => {
	const text = inputText.value.trim();
	if (!text.startsWith('/')) return false;

	// 允许 "/#" 作为注释不执行
	if (text.startsWith('/#')) return true;

	const { command, args, params } = parseCommand(text);
	const [execute] = COMMAND_REGISTRY[command] || [];

	try {
		if (execute) {
			// 清空输入框（除非是 help 指令想保留内容）
			if (command !== 'help') inputText.value = "";

			await execute(args, params, inputText);
		} else {
			showToast(`未知指令: /${command}`, 'error');
		}
	} catch (e) {
		console.error(e);
		showToast(e.message || "执行指令出错", 'error');
	}

	return true;
};