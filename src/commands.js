import {showToast} from "./components/Toast.js";
import {config, messages} from "./states.js";
import {unconscious} from "unconscious";
import {tokenize} from "unconscious/common/StringTokenizer.js";
import {submitUserChatMessage} from "./api-request.js";
import SimpleModal from "./components/SimpleModal.jsx";

/**
 * 指令处理器定义
 * @typedef {[function(string[], Record<string, string>): Promise<void>|void, string?]} CommandHandler
 */

/** @type {Record<string, CommandHandler>} */
export const COMMAND_REGISTRY = {
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
	],
	"continue": [
		() => {
			const msg = unconscious(messages).at(-1);
			if (msg?.role !== 'assistant') {
				showToast("最后一条消息角色不是助手", "error");
				return;
			}
			if (!config.canPrefill) {
				showToast("未在设置中启用Prefill", "error");
				return;
			}
			msg.finish_reason = 'interrupt';
			submitUserChatMessage();
		},
		"继续上一条助手消息"
	],
	"share": [
		async () => {
			const qr = await import("unconscious/common/qr.js");
			const canvas = qr.renderQRCodeToCanvas(location.href);
			SimpleModal({
				title: "手机浏览器扫码打开",
				message: <>{location.href}<br/>{canvas}</>
			})
		},
		"在手机上打开这条对话 (WIP)"
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

	for (let i = 0; i < parts.length; i++) {
		const str = parts[i];
		if (str.startsWith("--") && str.indexOf(' ') < 0) {
			params[str.substring(2)] = parts[++i];
		} else {
			args.push(str);
		}
	}

	return { command, args, params };
};

/**
 * 主入口函数
 * @param {import("unconscious").Reactive<string>} inputText
 * @returns {Promise<boolean>} 是否拦截了输入
 */
export const handleCommand = async (inputText, element) => {
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

			await execute(args, params, element);
		} else {
			showToast(`未知指令: /${command}`, 'error');
		}
	} catch (e) {
		console.error(e);
		showToast(e.message || "执行指令出错", 'error');
	}

	return true;
};