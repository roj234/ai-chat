import {runSchemaRole, USER_PROMPT} from "../core.js";
import "./StoryTurn.css";
import {$once, createReactiveMarkdown, registerSchemaMessageRole, schemaToPrompt} from "/common/ReactiveJSON.js";
import {$foreach, $update, unconscious} from "unconscious";
import {
	abortCompletion,
	config,
	ensureActiveConversation,
	messages,
	selectedConversation,
	updateMessageUI
} from "/src/states.js";
import {COMMAND_REGISTRY} from "/src/commands.js";

import {UpdateVariable} from "../../tools/rp_kit/Variables.js";
import {runTools} from "/src/toolset.js";

const ID = 'my/storyTurn';

// 假设最新消息为index 0
// 1. [0, summaryDepth) 发送完整的 story 字段
// 2. [summaryDepth, ) 发送 summary 字段
// 3. 更长部分应该通过支持召回的上下文管理策略实现，例如主动或被动向文件系统总结
// 其中 第二部分每当属于它的消息索引可以整除 summaryInterval 时才会更新前缀
//
// 变量更新完全是实验性的，也许应该通过DM主代理方案。
// 不使用命令的话如何通过代码调用SchemaRole？
// 如何JSX解析甚至让LLM自己编写SchemaRole？
const memoryConfig = {
	// 到该对话深度开始使用 summary 字段，根据模型上下文和你的输出字数调
	summaryDepth: 20,
	// 深度达标之后，间隔多少条消息更新 summary 前缀状态，这会导致缓存失效
	summaryInterval: 20,
};

/**
 * 兄弟，这不比预设牛逼？
 * @type {OpenAI.ObjectSchema}
 */
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

		/*variable_update_analysis: {
			type: 'string',
			description: `Describe which variables need update.`,
		},*/

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

/**
 * 生成函数 (WIP)
 * @param {Partial<AiChat.Message>[]} messages
 * @param {string} prompt
 */
const sendAction = async (messages, prompt) => {
	await ensureActiveConversation();
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
	messages.push({
		role: "userPrompt",
		time,
		content: prompt,
		[USER_PROMPT]: `${schemaToPrompt(schemaToLLM, config.jsonSupport)}${promptPrefix}

除非另有要求，角色使用中文进行对话

## 用户输入（*斜体* = OOC指令, "引号" = 说话, 文本 = 行为）

${prompt}`
	});

	await runSchemaRole(ID, schemaToLLM, messages, { max_completion_tokens: 8000, });
};

const onCompleted = async (conv, messages, assistantResponse) => {
	const jsonData = assistantResponse.content;

	const variables = jsonData.variables;
	if (variables) {
		assistantResponse.tool_calls = variables.map(item => ({
			id: "tc_"+Math.random().toString(36).slice(2),
			type: "function",
			function: {
				name: "UpdateVariable",
				arguments: JSON.stringify(item)
			}
		}));
		assistantResponse.tool_responses = [];
		await runTools(assistantResponse, {
			...selectedConversation,
			tools: new Set(["UpdateVariable"])
		}, true);
	}

	const userMessage = messages.at(-2);
	if (userMessage.role === 'userPrompt') {
		delete userMessage.prompt;
		// 需要换一个对象才能让 keyFunc 更新
		messages[messages.length - 2] = {
			...userMessage,
			role: 'user'
		}
	}
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

	// 删掉思考过程、变量更新等字段
	const {reasoning, variables, ...data} = content;

	const alignedSummaryLength = Math.floor(length / memoryConfig.summaryInterval) * memoryConfig.summaryInterval;
	if (alignedSummaryLength - index >= memoryConfig.summaryDepth) delete data.story;
	else delete data.summary;

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
}, onCompleted);

// 注册命令
COMMAND_REGISTRY["turn"] = [
	(args) => {
		sendAction(messages, args[0].trim());
	},
	"再来一回合！"
];