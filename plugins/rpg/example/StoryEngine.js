import {jsonPrompt} from "../core.js";
import "./StoryEngine.css";
import {$once, createReactiveMarkdown, registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import {$foreach, $update, unconscious} from "unconscious";
import {schemaToPrompt} from "/common/schemaToTypeDef.js";
import {abortCompletion, config, messages} from "/src/states.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {COMMAND_REGISTRY} from "/src/commands.js";

const ID = 'my/storyEngine';

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		reasoning: {
			type: "string",
			description: "展开思考和推理，设想本轮角色的行为，发生在何时、何地、做出什么动作，产生什么行动。时间需要前进"
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
						description: "若是角色行动，填写姓名",
						anyOf: [{
							const: "narrator"
						}, {
							type: "string"
						}]
					},
					content: {type: "string", description: "描写文字或对话内容，可以使用 markdown"},
					pose: {type: "string", description: "可选：角色的表情/动作"}
				},
				required: ["character", "content"],
				additionalProperties: false
			}
		},

		summary: {
			type: "string",
			description: "200字以内描述本轮发生了什么事情"
		},

		variables: {
			type: "array",
			description: "变量更新",
			items: {
				type: "object",
				properties: {
					name: {
						type: "string",
						pattern: "^[a-z_]+$"
					},
					action: {
						type: "string",
						enum: ["get", "set", "add", "append", "merge", "delete"],
					},
					value: {
						type: "value"
					},
				},
				required: ["name", "action"],
				additionalProperties: false
			}
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
		"variables"
	],
	additionalProperties: false
};
// 兄弟，这不比预设牛逼？

/**
 * 生成函数 (WIP)
 * @param {Partial<AiChat.Message>[]} messages_
 * @param {string} prompt
 */
export async function sendAction(messages_, prompt) {
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
	messages_.push({
		id: -1,
		role: "user",
		time,
		content: schemaToPrompt(schemaToLLM, config.jsonSupport) + promptPrefix + "\n\n你必须在 dialogue 和 action 字段中使用中文，除非设定要求角色使用其他语言\n\n" +
			"## 用户输入（*斜体*为世界发生的变化，非玩家行为）\n\n" + prompt
	});

	const originalPrompt = {
		role: "user", // TODO /say for re-execute?
		time,
		content: prompt
	};

	let assistantResponse;
	try {
		assistantResponse = await jsonPrompt(schemaToLLM, messages_, {
			reasoning: {enabled: enableThink},
			max_tokens: 8000,
		}, ID);
	} catch (e) {
		console.error(e);
		// BranchManager 唯三的 API
		messages_[messages_.length - 2] = originalPrompt;
		return;
	}

	// BranchManager 唯三的 API
	messages_.splice(messages_.length - 2, 2,
		originalPrompt,
		{
			...assistantResponse,
			role: ID,
			content: JSON.parse(assistantResponse.content)
		}
	);
}

/**
 * 渲染函数
 * @param {import("unconscious").Reactive<Schema.StoryEngine>} val
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
					<span>{item.name} {item.action} {() => JSON.stringify(unconscious(item).value)}</span>
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
 * @param {Schema.StoryEngine} content
 * @param {OpenAI.Message[]} output
 * @param _
 * @param {number} index
 * @param {number} length
 */
const composer = ({content}, output, _, index, length) => {
	if (content.suggested_choices) {
		delete content.suggested_choices;
		$update(updateMessageUI);
	}

	// 删掉思考过程
	const {reasoning, ...data} = content;

	// 5轮对话后只保留摘要
	const is_last_nth = index + 10 < length;
	if (is_last_nth) delete data.summary;
	else delete data.story;

	output.push({
		role: "assistant",
		content: JSON.stringify(data)
	});
};

// 注册渲染器
registerSchemaMessageRole(ID, '富文本故事示例', renderer, composer, {
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
	"开启或继续一段富文本故事"
];