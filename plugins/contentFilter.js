import {getToolParameters, registerToolset} from "/src/toolset.js";
import {formatSize} from "unconscious/common/Utils.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {createReactiveJSON, createReactiveMarkdown} from "/common/ReactiveJSON.js";
import {openContextMenu} from "/src/components/Menu.js";
import {unconscious} from "unconscious";
import {EVENT_BUS, MessageRoles, onConversationLoaded, selectedConversation} from "/src/states.js";
import {getImmediateMessages, markMessageDirty, updateConversation} from "/src/database.js";
import {showToast} from "/src/components/Toast.js";

import {customRoleRegHelper} from "./pluginApi.js";

/** @type {AiChat.FunctionTool} */
const SubmitResponse = {
	name: "SubmitResponse",
	description: 'Put your complete response in "content". No text outside.',

	interactive: true,
	script(par, response, conv) {
		if (response.ran) return "Submitted";
		response.ran = true;

		if (conv.acf.convert) {
			const msgs = getImmediateMessages(conv);
			const last = msgs.at(-1);
			const tr = last.tool_responses;
			const idx = tr?.indexOf(response);
			if (idx != null && idx >= 0) {
				if (tr.length === 1) {
					delete last.tool_calls;
					delete last.tool_responses;
					last.finish_reason = 'stop';
				} else {
					last.tool_calls.splice(idx, 1);
					last.tool_responses.splice(idx, 1);
				}
				last.content += par.content;
				markMessageDirty(last);
			}
		}
	},
	title: (req, ctx) => {
		const par = getToolParameters(ctx, req);
		return `正文 (${par ? formatSize(par.content.length) : "..."})`
	},
	renderInput: (ctx, box, tc) => {
		const par = getToolParameters(ctx, tc);
		return par ? "省略，见下文" : false;
	},
	renderOutput: () => "",

	artifact: 'o',
	renderer(ctx, final, tc) {
		const par = getToolParameters(ctx, tc);
		return renderMarkdownToElement(<div className="md" />, par.content);
	},
	streamRenderer(inputBox) {
		const [proxy, update] = createReactiveJSON();
		inputBox.replaceWith(createReactiveMarkdown(<div className="md"/>, proxy.content));
		return update;
	},

	parameters: {
		type: "object",
		properties: {
			content: {
				type: "string",
				description: 'Your complete response.',
			},
		},
		required: ["content"]
	}
};
const name = SubmitResponse.name;

const ID = "ContentFilter";

EVENT_BUS.on('makeRequestBody', (conv, _, body) => {
	if (conv.acf?.enforce) {
		if (body.tool_choice != null) throw ID+": 请求体已存在 tool_choice 字段";
		body.tool_choice = {
			type: "function",
			function: { name }
		}
	}
});

const [registerRole, unregisterRole] = customRoleRegHelper(ID);

onConversationLoaded((conv, path, messages) => {
	if (conv.acf?.transform) registerRole(conv, messages);
});

MessageRoles[ID] = {
	async preprocess(self, messages, conv) {
		const output = [...messages];

		let seq = 1;

		let k = 0;
		for (let i = 0; i < output.length; i++, k++) {
			const m = output[i];
			const content = m.content;
			if (m.role !== 'assistant' || !content) continue;

			if (Array.isArray(content)) {
				showToast(ID+`: 跳过 messages[${i}] 的 Transform: 多模态内容`);
				continue;
			}
			if (m.tool_calls?.some(s => s.function.name === name)) {
				showToast(ID+`: 跳过 messages[${i}] 的 Transform: 已存在 ${name} 工具`);
				continue;
			}

			output[i] = {
				...m,
				content: "",
				tool_calls: [
					...m.tool_calls ?? [],
					{
						id: `_${name}_` + seq++,
						type: 'function',
						function: {
							name: name,
							arguments: JSON.stringify({content})
						}
					}
				],
				tool_responses: [
					...m.tool_responses ?? [],
					{success: true, content: `Submitted`}
				]
			};
		}

		return output;
	}
}

registerToolset(ID, `反输出审核
听说AG的哈基米不审工具调用
右键或长按打开配置菜单
Adagio: 输出的工具调用转为正文（建议开）
Moderato: 输入中的正文转为工具调用（选开）
Allegro: 阻止模型输出正文（会无法调用其它工具）`, [SubmitResponse], {
	hidden: "manual",
	systemPrompt: `Respond by calling ${name} now, with your complete response in "content". NO TEXT OUTSIDE THAT TOOL CALL.`,
	menu: (ev) => {
		const conv = unconscious(selectedConversation);
		const acf = conv?.acf;
		if (!acf) return;

		ev.preventDefault();
		openContextMenu(ev, ev.target.closest('ul'), [
			{icon: acf.convert ? "ri-checkbox-line" : "ri-volume-mute-line", label: "Adagio", act: () => {
				acf.convert ^= 1;
				updateConversation(conv);
			}},
			{icon: acf.transform ? "ri-checkbox-line" : "ri-music-line", label: "Moderato", act: () => {
				const now = acf.transform ^= 1;
				if (now) registerRole(conv)
				else unregisterRole(conv)
				updateConversation(conv);
			}},
			{icon: acf.enforce ? "ri-checkbox-line" : "ri-music-2-line", label: "Allegro", act: () => {
				acf.enforce ^= 1;
				updateConversation(conv);
			}},
		], true);
	},
	onActivated(conv) {
		conv.acf = { convert: 1, transform: 1 };
		registerRole(conv)
		return [SubmitResponse];
	},
	onDeactivated(conv) {
		unregisterRole(conv)
		delete conv.acf;
	}
});