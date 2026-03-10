import {jsonPrompt, schemaWrapper} from "../Constraint.js";

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// 构建基调
		name: {
			type: "string",
			description: "世界观名称。如果用户已提供则进行优化润色；如果用户未提供，请根据内容提炼一个契合且霸气的名字。"
		},
		theme: {
			type: "array",
			minItems: 3,
			maxItems: 10,
			items: {
				type: "string",
				maxLength: 15,
			},
			description: "核心主题。以简明的短语（8字以内）概括核心矛盾与深层内涵，每个标签应当是一个深刻的哲学命题或社会矛盾（如：宿命与自由、肉体与机械的边界），请勿在此处长篇大论。"
		},
		style: {
			type: "string",
			description: "文风基调。先用一两句话在此界定叙事基调（如：悲情浪漫与现实主义交织），然后用分点列表清晰说明整体文风特点（叙事手法、思想内核等），不少于150字，并提供一个约200字的典型场景描写范例。"
		},

		// 推演，顺便充当后续的思维链
		description: {
			type: "string",
			description: "详细的核心摘要。如果用户已提供基础描述，请在此基础上极大地扩写丰富。要求包含世界观的起源、现状，文笔优美且富有深度，字数不少于200字，采用段落排版。"
		},

		// 时空舞台
		age: {
			type: "string",
			description: "时代背景。先用一段话概括时代背景名称与大致阶段，随后运用【数字序列 (1, 2, 3)】分点详细阐述时代特征、历史纪元等情况，总字数不少于200字。"
		},
		geography: {
			type: "string",
			description: "地理格局。先概述核心地理格局，随后采用分点列表详细罗列主要地理区域分布、极端气候、矿产资源及地貌特征，条理清晰，总字数不少于250字。"
		},

		// 世界规则
		leveling: {
			type: "string",
			description: "能力体系。先用一句话总结力量体系名称，然后将其划分为几个层级/维度，使用【数字序号加子横杠 (-)】的嵌套列表结构，解释各个层级的机制、代价或表现，不少于250字。"
		},
		social: {
			type: "string",
			description: "社会规则。先概述社会制度核心，将其细分为多个领域（例如：政治、法律、宗教、经济体系等），使用【数字序号加子横杠 (-)】的嵌套结构进行详尽描写，不少于300字。"
		},

		// 示例
		factions: {
			type: "array",
			minItems: 3,
			maxItems: 10,
			description: "主要派系/势力。列举至少3个关键势力。",
			items: {
				type: "object",
				properties: {
					name: { type: "string", description: "势力名称，如：唐门" },
					description: { type: "string", description: "势力描述。大概150字，讲明其背景、宗旨、核心成员、控制区域、内部状态等。" },
				},
				required: ["name", "description"],
				additionalProperties: false
			}
		},
		attribute_schema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "内部名称，如 HP MP STR" },
					name: { type: "string", description: "UI显示名称，如 生命值 魔力值 魅力 感知" },
					description: { type: "string", description: "该属性的机制解释及在判定中的作用" },
					"rank_rule": {
						type: "string",
						description: "属性的值域范围与常人基准。例如：'1-20，常人为10' / '从X到Y的字母评级' / '常人无此属性，修仙者以万为突破单位'。必须说清楚取值标准。"
					},
					prefix: {
						type: "string",
						example: ["Lv.", "$", "￥"],
						description: "数值的UI前缀，可选。"
					},
					postfix: {
						type: "string",
						example: ["%", "吨", "元", "张"],
						description: "数值的UI后缀/单位，可选。"
					},
					type: { enum: ["string", "number", "boolean"] },
					enum: {
						type: "array",
						description: "如果字符串评级可枚举，请在这里完全列出，否则省略",
						items: {
							type: "string",
						}
					},
					color: { type: "string", pattern: "^[0-9a-fA-F]{6}$", description: "属性的Hex颜色代码" },
				},
				required: ["id", "name", "description", "rank_rule", "type", "color"],
				additionalProperties: false
			}
		}
	},

	// 注意：这里的 required 数组顺序纯属标明哪些必须，不起生成顺序作用。实际生成顺序看上面的 properties 声明顺序。
	required: [
		"name", "theme", "style", "description",
		"age", "geography", "leveling", "social",
		"factions", "attribute_schema"
	],
	additionalProperties: false
};

/**
 * @typedef {{
 *     name: string,
 *     theme: string,
 *     style: string,
 *     description: string,
 *     age: string,
 *     geography: string,
 *     leveling: string,
 *     social: string,
 *     factions: string[]
 *     attribute_schema: string[],
 * }} World
 */

export async function generateWorld(prompt) {
	return await jsonPrompt([
		{
			role: "system",
			content: `你是一位顶级的网文/小说世界观架构师与设定补全专家。
你的任务是根据用户提供的零散文本或设定雏形，构建或扩充出一套宏大、严谨、逻辑自洽且极具吸引力的“世界观设定书”。

## 排版标准
你必须严格按照指定的 JSON 格式进行返回。针对其中大部分需要详细描述的文本字段（age, geography, style, leveling, social），请务必采用以下类 Markdown排版规范输出长文本：
1. **首段定调**：每一项内容开始前，必须先写一段或一句话进行核心概括。
2. **严格分点**：核心概括后，务必使用 "1. XXX:" 配合其下属的 "- yy" 列表符进行层级拆解。
3. **信息密度**：切忌空洞乏味，必须填充详细的设定细节。
参考排版范例（在对应字段中应用）：
总结性的一句话概括。
1. 一级核心设定：
  - 二级解释A：详尽说明
  - 二级解释B：详尽说明
2. 另一个核心设定：
  ... 

## 填充要求
1. 请根据用户的灵感碎片，扩写并完善这一份世界观设定书。如果碎片为空，请自主创作一个全新的世界观。
2. 若用户仅提供了简短描述，你需要发挥惊艳的想象力，自动推演补全它的时代、人文、地理和社会阶级。
3. 若用户尚未提供明确的名字和摘要，根据文字氛围，起一个合适且具有辨识度的名字并编写完整的背景序言。

## 格式规范
\`\`\`json
` + JSON.stringify(schema) + "\n```",
		},
		{
			role: "user",
			content: prompt
		}
	], {
		...schemaWrapper("world_book", schema),
		reasoning: { enabled: false },
		//min_p: 0.1,
		//temperature: 1.2,
		max_tokens: 10000,
	});
}
