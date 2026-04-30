import {jsonPrompt, schemaWrapper} from "../Constraint.js";

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		design: {
			type: "string",
			description: "想想场景要怎么设计。"
		},

		// 场景定调
		background: {
			enum: [],
			description: "背景名称。"
		},
		character: {
			enum: [],
			description: "角色名称（显示立绘用）。"
		},

		content: {
			type: "string",
			description: "角色说的话，非必须不要换行，可以使用markdown粗体、斜体、引号。"
		},

		suggested_choices: {
			type: "array",
			minItems: 2,
			maxItems: 4,
			description: "给{{user}}提供的选项建议（对话或行为），对话使用“”包裹，行动使用『』包裹。",
			items: {
				type: "string",
				description: "具体的选项描述（例如：『拔出腰间的生锈铁剑，正面迎战无头骑士。』或“今天天气真不错，对吧？”）"
			}
		}
	},
	required: [
		"design", "background", "character",
		"content", "suggested_choices"
	],
	additionalProperties: false
};

/**
 *
 */
export async function generateGalAction(messages, prompt) {
	return await jsonPrompt([
		{
			role: "system",
			content: `
			这是系统提示词
## 格式规范
\`\`\`json
` + JSON.stringify(schema, null, 2) + "\n```"
		},
		{
			role: "user",
			content: prompt
		}
	], {
		...schemaWrapper("galgame", schema),
		reasoning: { enabled: false },
		//min_p: 0.1,
		//temperature: 1.15,
		max_tokens: 8000,
	});
}