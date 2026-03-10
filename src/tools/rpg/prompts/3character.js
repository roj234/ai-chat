import {jsonPrompt, schemaWrapper} from "../Constraint.js";

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT
		design: {
			type: "string",
			description: "【设计推演】请首先结合世界观设定和用户灵感，简短构思该角色的核心命运轨迹和冲突点（约100字）。"
		},

		// 基础信息
		name: {
			type: "string",
			description: "角色真名。用户**提供则直接用**，否则根据世界观生成一个契合的名字。"
		},
		alias: {
			type: "string",
			description: "角色的代号、绰号或江湖头衔（例如：夜魔、北边的柯南），必须是公开的，人尽皆知的，如果是其他人不知道的，必须写在 tags 里。"
		},
		sex: {
			type: "string",
			example: ["男", "女"],
			description: "性别"
		},
		race: {
			type: "string",
			description: "种族（如：人类、猫娘、魅魔）"
		},
		age: {
			type: "string",
			description: "年龄或存在时长（如：24岁、13个轮回）。"
		},

		background: {
			type: "string",
			description: "背景传记，充当核心思维链，采用段落排版，详细描写该角色的身世、核心动机、过去的辉煌或创伤。文风需高度契合世界观，字数不少于250字。"
		},
		appearance: {
			type: "string",
			description: "外貌特征描写。包含体型、五官、气质与日常穿搭风格。请结合角色的【背景】与【职业】，描写其身上的生活痕迹或气质（例如：常年不见阳光的苍凉感、双手布满老茧、因过度使用魔法而发生变异、衣着华贵但也掩盖不住的颓废），拒绝千篇一律的外貌，注重氛围感，约150字。"
		},
		faction: {
			type: "string",
			description: "所属阵营/派系。或设定为游离于势力之外的身份。"
		},
		flaw: {
			type: "string",
			description: "角色的致命弱点、心理创伤（PTSD）或偏执的执念。这是让人设更加立体的关键（如：极度贪财、幽闭恐惧、无法对求救者视而不见）。"
		},

		// 逻辑
		tags: {
			type: "array",
			minItems: 3,
			maxItems: 9,
			items: {
				type: "object",
				properties: {
					name: { type: "string", maxLength: 30 },
					description: { type: "string", description: "简单描述，约50字。" }
				},
				required: ["name", "description"],
				additionalProperties: false
			},
			description: "身份（职业）、性格标签、特质或社会声望等（如：落魄剑修、大善人、S级通缉犯、旧神信徒）。不要将具体战斗技能写在这里"
		},
		skills: {
			type: "array",
			minItems: 2,
			maxItems: 6,
			description: "基于世界观的个人初始特长、异能、天赋等。需带有具体的机制色彩（如：鲜血献祭、斗气化马，神赐治疗术）",
			items: {
				type: "object",
				properties: {
					name: { type: "string", maxLength: 30 },
					"cost_and_limit": {
						type: "string",
						description: "发动的代价、副作用或苛刻的前置条件。除了传统的数字消耗（比如每天一次，消耗40MP）以外，请写出更具有【叙事张力】的限制（例如：理智值急剧下降、需要献祭至亲之血、会导致肢体产生不可逆的机械异化、只能在雷雨夜使用等）。大约50字。"
					}
				},
				required: ["name", "description"],
				additionalProperties: false
			}
		},
		attributes: {
			type: "object",
			description: "角色的初始数值面板。请根据上方生成的背景、外貌、缺陷等，为这些字段赋予合理的初始值",
			additionalProperties: false
		},
	},
	required: [
		"design", "name", /*"alias", */"sex", "race", "age",
		"appearance", "faction", "background", "flaw",
		"tags", "skills", "attributes"
	],
	additionalProperties: false
};

/**
 * @typedef {{
 *     name: string,
 *     sex: string,
 *     race: string,
 *     age: string,
 *     appearance: string,
 *     faction: string,
 *     background: string,
 *     flaw: string,
 *     tags: string[]
 *     skills: string[],
 *     attributes: string[]
 * }} Character
 */

/**
 *
 * @param {import("./1world.js").World} world
 * @param prompt
 * @return {Promise<Character>}
 */
export async function generateCharacter(world, prompt) {
	schema.properties.faction.enum = [...world.factions.map(a => a.name), "无"];
	const attr = {};
	schema.properties.attributes.properties = attr;
	schema.properties.attributes.required = world.attribute_schema.map(f => f.id);

	for (const x of world.attribute_schema) {
		const { id, name, type } = x;
		const schema = {
			type,
			description: name
		};
		if (x["enum"]?.length) {
			schema["enum"] = x["enum"];
		}
		attr[id] = schema;
	}

	return await jsonPrompt([
		{
			role: "system",
			content: `你是一位顶级的跑团游戏（TRPG）与小说角色架构师。
你的任务是基于已定稿的【世界观设定】，并参考用户提供的灵感碎片，为用户构筑一位极具魅力的主角（PC）角色卡。

## 角色设计准则
1. **世界观契合度**：角色必须完完全全嵌入给定的世界观体系中。严格使用世界观提供的力量体系层级、专属名词和社会法则，不要引入新的设定。
2. **文风一致性**：描述文风需继承世界书的【文风基调】，背景故事要深刻、有张力，充满宿命感或戏剧冲突。
3. **属性严谨性**：严格对照下方【角色属性】列表的 ID 与设定，赋予合乎角色背景初期的逻辑数值。请务必遵守每个属性专属的取值区间与基准规则（如评级、点数范围）。

## 世界观 《${world.name}》

### 摘要
${world.description}

### 核心主题
${world.theme.map(f => `- ${f}`).join('\n')}

### 文风与基调
${world.style}

### 时代背景
${world.age}

### 地理格局
${world.geography}

### 社会阶级
${world.social}

### 力量体系
${world.leveling}

### 主要势力
${world.factions.map(f => `- **${f.name}**：${f.description}`).join('\n')}

### 角色属性
${world.attribute_schema.map(f => {
				let text = `- **${f.id} (${f.name})**：${f.description}  \n  评分标准：${f.rank_rule}`;
				if (f.prefix) text += "  \n  属性前缀："+f.prefix;
				if (f.postfix) text += "  \n  属性后缀："+f.postfix;
				return text;
			}).join('\n')}

## 格式规范
\`\`\`json
`+JSON.stringify(schema)+"\n```"
		},
		{
			role: "user",
			content: prompt
		}
	], {
		...schemaWrapper("character", schema),
		reasoning: { enabled: false },
		//min_p: 0.1,
		//temperature: 1.1,
		max_tokens: 10000,
	});
}
