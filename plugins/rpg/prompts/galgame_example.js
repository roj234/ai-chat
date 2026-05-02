import {jsonPrompt, schemaWrapper} from "../Constraint.js";

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		reasoning: {
			type: "string",
			description: "展开思考和推理，设想接下来一个回合的非玩家角色（NPC）行为，发生在何时、何地、做出什么动作，产生什么行动。"
		},

		location: {
			type: "string",
			description: "地点",
			example: "XX镇 - 黑铁酒馆"
		},
		date: {
			type: "string",
			description: "日期与时间",
			example: "X历1234年5月6日 上午 10:30"
		},

		behaviours: {
			type: "array",
			// 这个可以换成 anyOf 硬约束
			description: "按时间顺序列出该回合内角色的对话和行为, dialogue 和 action 至少一个不为空",
			minItems: 1,
			items: {
				type: "object",
				properties: {
					character: {
						type: "string",
						description: "角色名称。"
					},
					dialogue: {
						type: "string",
						description: "角色说的话，非必须不要换行，可以使用markdown粗体、斜体、引号。"
					},
					action: {
						type: "string",
						description: "角色做出的动作"
					}
				},
				required: [ "character" ],
				additionalProperties: false
			}
		},

		deltas: {
			type: "object",
			properties: {
				time: {
					type: "string",
					// TODO 也许可以用pattern让AI返回时间戳，但是这适合吗？
					description: "在该回合后，时间是？"
				},
				location: {
					type: "string",
					description: "在该回合后，地点是？"
				},
				summary: {
					type: "string",
					description: "200字以内描述该回合发生了什么事情"
				},
				variables: {
					type: "array",
					description: "变量更新",
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								pattern: "^[a-zA-Z]+$",
								description: "变量名称"
							},
							action: {
								enum: ["get", "set", "add", "append", "merge", "delete"],
							},
							value: {
								type: "value"
							}
						}
					}
				}
			},
			required: [
				"time", "location", "summary", "variables"
			],
			additionalProperties: false
		},

		suggested_choices: {
			type: "array",
			maxItems: 4,
			description: "如果该回合有Tav参与，给Tav提供选项建议（对话或行为），对话使用“”包裹，行动使用『』包裹。",
			items: {
				type: "string",
				description: "具体的选项描述（例如：『拔出腰间的生锈铁剑，正面迎战无头骑士。』或“今天天气真不错，对吧？”）"
			}
		}
	},
	required: [
		"reasoning", "location", "date",
		"behaviours", "deltas"
	],
	additionalProperties: false
};

/**
 *
 */
export async function generateGalAction(messages, prompt) {
	return await jsonPrompt([
		...messages,
		{
			role: "user",
			content: `
			你的响应必须严格遵循如下JSON Schema，并在对话和行为中使用中文
## 格式规范
\`\`\`json
` + JSON.stringify(schema, null, 2) + "\n```\n" +
				"## 玩家输入（*斜体*为世界发生的变化，非玩家行为）\n\n" +prompt
		}
	], {
		...schemaWrapper("galgame", schema),
		reasoning: { enabled: false },
		max_tokens: 8000,
	});
}