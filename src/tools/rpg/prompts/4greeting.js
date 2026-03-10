import {jsonPrompt, schemaWrapper} from "../Constraint.js";

/** @type {OpenAI.ObjectSchema} */
const schema = {
	type: "object",
	properties: {
		// CoT 推演
		design: {
			type: "string",
			description: "【开局推演】分析主角当前的处境。结合其背景、弱点以及传入的【暗线前奏】，构思一个极具戏剧性、且迫使主角立刻做出反应的具体场景（如：正在被追杀、从冷冻舱苏醒发现飞船警报大作、在酒馆被人用枪指着头）。约150字。"
		},

		// 场景定调
		time_and_location: {
			type: "string",
			description: "具体的发生时间与精细地点（如：永夜历312年 猎魔人公会地下三层的发霉牢房 / 某个暴雨倾盆的周二午夜 霓虹闪烁的垃圾场）。"
		},
		environment_rendering: {
			type: "string",
			description: "环境与感官渲染。重点描写光影、气味、温度或诡异的声响，为后续文本奠定氛围基调。一到两句话即可。"
		},

		// 主菜：开场白
		event_prologue: {
			type: "string",
			description: "【核心开场白】以『第二人称（你）』进行长篇叙述。不要平铺直叙地介绍世界观，而是直接描写当前正在发生的动作和危机（In medias res 手法）。在文中自然地融入主角的外貌特征或背景痕迹，并巧妙地埋入【暗线前奏】的伏笔。结尾必须停在一个时间紧迫、需要玩家立刻做出抉择的生死悬念上。字数不少于400字，采用段落排版。"
		},

		// 状态监控
		initial_status: {
			type: "object",
			properties: {
				description: {
					type: "string",
					description: "主角此时此刻的生理与心理状态（可能带有初始的轻微受难，例如：剧烈的宿醉、左臂有一道流血的新鲜裂口、处于某种能力被封印的虚弱期）。"
				},
				delta: {
					type: "array",
					items: {
						type: "object",
						properties: {
							action: {
								enum: ["get", "set", "add", "append", "merge", "delete"],
								description: "读取数据, 覆盖数据, 加减数值类型, 追加数组类型, 合并对象类型, 删除"
							},
							key: {type: "string", description: "变量名，格式为JSONPath，比如 'user_pref.likes[0]'，存数据时，应该合理的设计路径，保证路径含义清晰且唯一。"},
							value: {
								type: ["value"],
								description: "数据的内容，add时传数字（负数为减），append时传数组或元素，merge时传对象，delete时传索引或值。"
							}
						},
						required: ["action", "key", "value"]
					}
				}
			},

			required: ["description", "delta"],
			additionalProperties: false
		},

		// 引导选项（给不知道怎么开始的用户）
		suggested_actions: {
			type: "array",
			minItems: 2,
			maxItems: 4,
			description: "给玩家提供的、符合其性格标签与技能的初始行动建议。",
			items: {
				type: "string",
				description: "具体的行动选项描述（例如：『拔出腰间的生锈铁剑，正面迎战无头骑士。』或『利用[暗影亲和]天赋，立刻翻窗遁入下水道逃生。』）"
			}
		}
	},
	required: [
		"design", "time_and_location", "environment_rendering",
		"event_prologue", "initial_status", "suggested_actions"
	],
	additionalProperties: false
};

/**
 * 生成跑团/小说的初始事件 (Event #0)
 * @param {import("./1world.js").World} world 世界书概览
 * @param {import("./3character.js").Character} character 角色卡
 * @param {Object} firstNode 暗线/主线的第一个触发节点 (提供征兆 seed)
 * @param {String} prompt 用户开局的特殊要求（可选）
 */
export async function generateGreeting(world, character, firstNode, prompt) {
	return await jsonPrompt([
		{
			role: "system",
			content: `你是一位顶尖的跑团守秘人（Keeper）与金牌网文开局构架师。
你的任务是为玩家生成引人入胜的【初始事件/开场白】。

## 创作核心原则（必读）
1. **切忌平铺直叙**：千万不要像说明书一样罗列世界观或角色过去！这些玩家已经知道了。你要做的是直接让动作发生（比如直接写刀锋已经贴到了脖子上，或者雷声刚刚盖过惨叫）。
2. **五感拉满**：使用视、听、嗅、触觉来建立场景的真实感。
3. **埋下伏笔**：必须在描写中，极其自然地融入下方的【暗线初显征兆】，不要生硬，哪怕只是一瞥而过的异象。
4. **结尾悬念**：最后一段必须抛出一个迫在眉睫的抉择，逼迫玩家行动。

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

## 主角 ${character.name} 简述

### 基本信息
${character.sex}，${character.age}，${character.race}，所属势力：${character.faction}

### 外貌
${character.appearance}

### 标签
${character.tags.map(t=>`- **${t.name}**：${t.description}`).join('\n')}

### 弱点/执念：
${character.flaw}

### 背景
${character.background}

### 属性
${world.attribute_schema.map(f => `- **${f.name}**  \n  简介：${f.description}  \n  评分标准：${f.rank_rule}  \n  值：${character.attributes[f.id]}`).join('\n')}

## 格式规范
\`\`\`json
` + JSON.stringify(schema, null, 2) + "\n```"
		},
		{
			role: "user",
			content: `
## 本场暗线（必须埋入场景中）：
- 事件：${firstNode.nodes[0].trigger_condition}
- 线索：${firstNode.nodes[0].seed}
- 动机：${firstNode.nodes[0].hook}
- 发展：${firstNode.nodes[0].growth_mechanism}
- 结果：${firstNode.nodes[0].consequence}

## 数据存储
玩家属性存储于对象 player 下，可参考 set "player.HP" 50

## 字数
约 5000 字

## 剧情灵感/要求
${prompt}`.trim()
		}
	], {
		...schemaWrapper("greeting", schema),
		reasoning: { enabled: false },
		//min_p: 0.1,
		//temperature: 1.15,
		max_tokens: 8000,
	});
}