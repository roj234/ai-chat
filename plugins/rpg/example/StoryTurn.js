import {jsonPrompt} from "../core.js";
import "./StoryTurn.css";
import {$once, createReactiveMarkdown, registerSchemaMessageRole, schemaToPrompt} from "/common/ReactiveJSON.js";
import {$foreach, $update, unconscious} from "unconscious";
import {abortCompletion, config, messages, selectedConversation} from "/src/states.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {COMMAND_REGISTRY} from "/src/commands.js";

import {UpdateVariable} from "../../tools/rp_kit/Variables.js";
import {runTools} from "/src/skills.js";

const ID = 'my/storyTurn';

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		reasoning: {
			type: "string",
			description: "展开思考和推理，设想本回合各个角色的行为，发生在何时、何地、做出什么动作，产生什么行动。时间需要前进"
		},

		location: {
			type: "string",
			//example: "闪金镇 - 黑铁酒馆"
		},
		date: {
			type: "string",
			description: "日期与时间",
			//example: "光明历1234年5月6日 上午 7:08"
		},

		story: {
			type: "array",
			//description: "按先后顺序列出该回合内角色的对话和行为, dialogue 和 action 不同时为空",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					character: {
						description: "角色名称",
						anyOf: [{
							const: "narrator"
						}, {
							type: "string"
						}]
					},
					content: {type: "string", description: "描写文字 and/or 对话内容，使用 markdown"},
					pose: {type: "string", description: "可选：角色的表情/动作"}
				},
				required: ["character", "content"],
				additionalProperties: false
			}
		},

		summary: {
			type: "string",
			description: "200字以内描述本回合发生了什么"
		},

		variables: {
			type: "array",
			description: `Update structured state such as inventories, HP, scores, flags, and other simulation data.
Variable naming: camelCase

Operation semantics:

- set     Overwrite: accepts any type. Missing intermediate objects are auto-created.
          Use \`/-\` as the final segment to append to an array (eg: \`/inventory/items/-\`).
- plus    Numeric delta: target must be a number; \`value\` is added as an increment (negative = decrement). If the path does not exist, baseline is 0.
- delete  Remove target: omit \`value\`. 
          Array element target will be spliced: delete "/inventory/items/1" -> splice index 1`,
			items: UpdateVariable.parameters
		},

		suggested_choices: {
			type: "array",
			maxItems: 4,
			description: "为{{user}}提供的选项建议（对话或行动），对话用“”包裹，行动不包裹。",
			example: ["拔出腰间的生锈铁剑，正面迎战无头骑士。", "“今天天气真不错，对吧？”"],
			items: {
				type: "string",
			}
		}
	},
	required: [
		"reasoning",
		"location",
		"date",
		"story",
		"summary",
		"variables",
		//"suggested_choices",
	],
	additionalProperties: false
};
// 兄弟，这不比预设牛逼？

/**
 * 生成函数 (WIP)
 * @param {Partial<AiChat.Message>[]} messages_
 * @param {string} prompt
 */
const sendAction = async (messages_, prompt) => {
	if (unconscious(abortCompletion)) return;

	let schemaToLLM = schema;
	let promptPrefix = '';
	const enableThink = !!config.think;
	if (enableThink) {
		//promptPrefix = "\n\n"+schema_.properties.reasoning.description;
		schemaToLLM = structuredClone(schema);
		delete schemaToLLM.properties.reasoning;
		schemaToLLM.required.shift();
	}

	const time = Date.now();
	const input_messages = [{
		role: "user", // TODO /say for re-execute?
		time,
		content: prompt
	}];

	messages_.push({
		id: -1,
		role: "userPrompt",
		time,
		content: prompt,
		prompt: `${schemaToPrompt(schemaToLLM, config.jsonSupport)}${promptPrefix}

除非另有要求，角色使用中文进行对话

## 用户输入（*斜体* = OOC指令, "引号" = 说话, 文本 = 行为）

${prompt}`
	});

	try {
		const assistantResponse = await jsonPrompt(schemaToLLM, messages_, {
			reasoning: {enabled: enableThink},
			max_tokens: 8000,
		}, ID);

		const jsonData = JSON.parse(assistantResponse.content);

		const variableTool = jsonData.variables;

		assistantResponse.tool_calls = variableTool.map(item => ({
			id: "tc_"+Math.random().toString(36).slice(2),
			type: "function",
			function: {
				name: "UpdateVariable",
				arguments: JSON.stringify(item)
			}
		}));
		assistantResponse.tool_responses = [];
		await runTools(assistantResponse, unconscious(selectedConversation) || {allowedTools: new Set(["UpdateVariable"])}, true);

		input_messages.push({
			...assistantResponse,
			role: ID,
			content: jsonData
		});
	} catch (e) {
		console.error(e);
	}

	// BranchManager 唯三的 API
	messages_.splice(messages_.length - 2, 2, ...input_messages);
};

/**
 * 渲染函数
 * @param {import("unconscious").Reactive<Schema.StoryTurn>} val
 * @return {JSX.Element[]}
 */
const renderer = (val) => {
	return [
		<header>
			<span>📍 {() => unconscious(val.location) || "加载中..."}</span>
			<span>{() => unconscious(val.date) || "--"} 📅</span>
		</header>,
		<div className="story">
			{$once(val.reasoning, () => <div className="reasoning">{val.reasoning}</div>)}
			{$foreach(val.story, (item) => {
				const elements = <>
					{createReactiveMarkdown(<div className="dialogue"/>, item.content)}
					<span className="action">{() => {
						const pose = unconscious(item.pose);
						return pose ? "("+pose+")" : null;
					}}</span>
				</>;

				//const type = unconscious(item.character);
				//if (type === "narrator") return <div className={"reasoning"}>{elements}</div>;
				return <div className={"card"}>
					<div className="character">{item.character}</div>
					{elements}</div>;
			})}
		</div>,
		<details className="footer" style={() => unconscious(val.summary) ? "" : "display:none"}>
			<summary>小结</summary>
			<div className="summary">{val.summary}</div>
			<div className="variables">
				{$foreach(val.variables, (item) => (
					<span>{item.pointer} {item.operation} {() => JSON.stringify(unconscious(item).value)}</span>
				))}
			</div>
		</details>,
		$once(val.suggested_choices, () => <div className="choices" onClick.delegate{"button"}={({delegateTarget}) => {
			sendAction(messages, delegateTarget.textContent);
		}}>
			{$foreach(val.suggested_choices, (item) => (
				<button>{item}</button>
			))}
		</div>)
	];
};

/**
 * 提示词构造函数
 * @param {AiChat.AssistantMessage & { content: StoryTurn }} msg
 * @param {OpenAI.Message[]} output
 * @param _
 * @param {number} index
 * @param {number} length
 * @param {AiChat.Conversation} conversation
 */
const composer = (msg, output, _, index, length, conversation) => {
	const {content, tool_calls, tool_responses} = msg;

	if (content.suggested_choices) {
		delete content.suggested_choices;
		$update(updateMessageUI);
	}

	// 删掉思考过程
	const {reasoning, variables, ...data} = content;
	// 5轮对话后只保留摘要
	const is_last_nth = length - index > 10;
	if (is_last_nth) delete data.summary;
	else delete data.story;

	output.push({
		role: "assistant",
		tool_calls,
		content: JSON.stringify(data)
	});

	if (tool_calls) {
		for (let i = 0; i < tool_calls.length; i++) {
			output.push({
				role: "tool",
				tool_call_id: tool_calls[i].id,
				content: tool_responses[i].content,
			});
		}
	}
};

// 注册渲染器
registerSchemaMessageRole(ID, 'CraftRPG回合参考实现', renderer, composer, {
	...schema,
	required: [
		"story",
		"summary"
	]
});

// 注册命令
COMMAND_REGISTRY["say"] = [
	(args) => {
		sendAction(messages, args[0].trim());
	},
	"再来一回合！"
];