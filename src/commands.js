import {showToast} from "./components/Toast.js";
import {beginConversation, messages, selectedConversation} from "./states.js";
import {duplicateConversation} from "./data-exchange.js";
import {updateConversation} from "./database.js";
import {loadPreset} from "./components/PresetDropdown.jsx";

/**
 *
 * @type {Record<string, function(string, Record<string, string>): void>}
 */
export const COMMANDS = {};

/**
 *
 * @param {HTMLTextAreaElement} element
 * @return {boolean}
 */
export function handleCommand(element) {
	const text = element.value.trim();
	if (!text.startsWith('/')) return false;

	let index = text.indexOf(' ');
	if (index < 0) index = text.length;
	const command = text.substring(1, index);
	if (command === "#") return true;

	const parameters = new Proxy({}, {
		get(target, key) {
			let targetElement = target[key];
			if (targetElement === undefined)
				throw new Error("缺少参数: "+key);
			if (targetElement.startsWith("\""))
				targetElement = JSON.parse(targetElement);
			return targetElement;
		}
	});
	try {
		parseParameters(text.substring(index+1), (key, value) => parameters[key] = value);

		switch (command) {
			default:
				const customHandler = COMMANDS[command];
				if (customHandler) customHandler(command, parameters);
				else {
					showToast("未知的指令", 'error');
					return true;
				}
			break;
			case "preset":
				if (loadPreset(parameters.name)) {
					showToast("已加载", 'success');
				}
			break;
			case "clear":
				messages.length = 0;
			break;
			case "dup":
				duplicateConversation();
			break;
			case "new":
				beginConversation();
				break;
			case "title":
				if (!selectedConversation.value) {
					showToast("未选中对话", 'error');
					return true;
				}

				selectedConversation.title = parameters.title;
				updateConversation(selectedConversation.value);
			break;
			case "":
			case "help":
				element.value = `/# 指令速查
/preset name=<name> 读取设定
/prompt name=<name> 使用之前保存的系统提示词模板 (未实现)
/dup 复制(备份)当前对话
/new 开启新对话
/clear 清空当前对话
/title title=<title> 设置对话标题
`;
				element.dispatchEvent(new InputEvent("input"));
				return true;
		}
	} catch (e) {
		console.error(e);
		showToast(e, 'error');
		return true;
	}

	element.value = "";
	return true;
}


const TOKEN_SAFE = /[0-9a-zA-Z!#$%&'*+-.^_`|~]/;
/**
 *
 * @param {string} fieldValue
 * @param {function(string, string|null): void} callback
 */
function parseParameters(fieldValue, callback) {
	let i = 0;
	let length = fieldValue.length;

	outerLoop:
		while (i < length) {
			do {
				if (fieldValue.charAt(i) !== ' ') break;
				i++;
			} while (i < length);

			let j = i;
			for (; j < length; j++) {
				let c = fieldValue.charAt(j);
				if (!TOKEN_SAFE.test(c)) break;
			}

			if (i === j) throw new Error("Empty token at("+i+"): "+fieldValue);
			const key = fieldValue.substring(i, j);

			if (j < length && fieldValue.charAt(j) === '=') {
				i = ++j;

				if (i < length) {
					if (fieldValue.charAt(i) === '"') {
						let isEscaped = false;
						while (true) {
							if (++i === length) throw new Error("Unterminated quoted-string at("+i+"): "+fieldValue);

							const c = fieldValue.charAt(i);
							if (c === '\\') {
								isEscaped = true;
							} else if (isEscaped) {
								isEscaped = false;
							} else if (c === '"') {
								i++;
								break;
							}
						}
					} else {
						for (; i < length; i++) {
							const c = fieldValue.charAt(i);
							if (!TOKEN_SAFE.test(c)) break;
						}
					}
				}

				const value = fieldValue.substring(j, i);
				callback(key, value);
			} else {
				i = j;
				callback(key, null);
			}

			let c;
			do {
				if (i === length) break outerLoop;
			} while ((c = fieldValue.charAt(i++)) === ' ');

			if (c !== ';') {
				throw new Error("Unrecognized token at("+i+"): "+fieldValue);
			}
		}
}
//endregion