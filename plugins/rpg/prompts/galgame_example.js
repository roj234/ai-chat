import {jsonPrompt, schemaWrapper} from "../Constraint.js";
import "./gal.css";
import {
	createReactiveMarkdown,
	registerSchemaMessageRole
} from "/common/ReactiveJSON.js";
import {$foreach, $update, unconscious} from "unconscious";
import {schemaToPrompt} from "/common/schemaToTypeDef.js";
import {messages} from "/src/states.js";
import {updateMessageUI} from "/src/components/MessageList.jsx";

const ID = 'my_plugin/story_engine';

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		reasoning: {
			type: "string",
			description: "展开思考和推理，设想接本轮非玩家角色（NPC）的行为，发生在何时、何地、做出什么动作，产生什么行动。时间需要前进"
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
						oneOf: [{
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
					// 如果你是在编写 标准的 Web API 文档或进行数据校验（如使用 Ajv, Python jsonschema 等库）：请使用 true 或 {}。
					value: true,
				},
				required: ["name", "action"],
				additionalProperties: false
			}
		},

		suggested_choices: {
			type: "array",
			maxItems: 4,
			description: "如果该回合有{{user}}参与，为{{user}}提供的选项建议（对话或行动），对话用“”包裹，行动不包裹。",
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
//console.log(schemaToTypeDef(schema, "StoryEngine"));

/**
 * @param {Partial<AiChat.Message>[]} messages
 * @param {string} prompt
 */
export async function generateGalAction(messages, prompt) {
	messages.push({
		id: -1,
		role: "user",
		content: schemaToPrompt(schema) + "\n\n你必须在 dialogue 和 action 字段中使用中文，除非设定要求角色使用其他语言\n\n" +
			"## 玩家输入（*斜体*为世界发生的变化，非玩家行为）\n\n" + prompt
	});

	// TODO 错误处理
	const response = await jsonPrompt(messages, {
		...schemaWrapper("schema", schema),
		reasoning: {enabled: false},
		max_tokens: 8000,
	}, ID);

	messages[messages.length-2] = {
		role: "user",
		content: prompt
	};

	response.role = ID;
	response.content = JSON.parse(response.content);
	console.log(messages.at(-1) === response);
	messages[messages.length-1] = response;
}

/**
 *
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
			<div className="reasoning">{val.reasoning}</div>
			{$foreach(val.story, (item) => {
				const elements = <>
					{createReactiveMarkdown(<div className="dialogue"/>, item.content)}
					<span className="action">{() => {
						const pose = unconscious(item.pose);
						return pose ? "(" + pose + ")" : null;
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
					// 请注意，这里使用了 $value 来引用 value，因为 value 自身是 Reactive 的保留名称
					<span>{item.name} {item.action} {() => JSON.stringify(item.$value)}</span>
				))}
			</div>
		</details>,
		<div className="choices" onClick.delegate{"button"}={({delegateTarget}) => {
			generateGalAction(messages, delegateTarget.textContent);
		}}>
			{$foreach(val.suggested_choices, (item) => (
				<button>{item}</button>
			))}
		</div>
	];
};

/**
 *
 * @param {Omit<AiChat.AssistantMessage, 'content'> & {"content": Schema.StoryEngine}} message
 * @param {OpenAI.Message[]} output
 * @param _
 * @param {number} index
 * @param {number} length
 */
const composer = (message, output, _, index, length) => {
	if (message.content.suggested_choices) {
		delete message.content.suggested_choices;
		$update(updateMessageUI);
	}

	const data = structuredClone(message.content);
	delete data.reasoning;

	const is_last_nth = index + 5 < length;
	if (is_last_nth) delete data.summary;
	else delete data.story;

	output.push({
		role: "assistant",
		content: JSON.stringify(data)
	});
};

registerSchemaMessageRole(ID, '故事机', renderer, composer);
