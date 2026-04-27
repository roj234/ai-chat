import {jsonPrompt, schemaWrapper} from "../Constraint.js";

const plot_node_schema = {
	type: "object",
	properties: {
		phase_name: {
			type: "string",
			description: "阶段名称（例如：暗流初现、图穷匕见、深渊回响、极昼终局）"
		},
		expected_turn: {
			type: "number",
			description: "预期在第几轮对话左右触发（整数）。请让各个阶段均匀分布在 1 到 targetTurns 之间。"
		},
		trigger_condition: {
			type: "string",
			description: "触发此节点的预期条件或进度。例如：'主角第二次进入教堂时'。"
		},
		seed: {
			type: "string",
			description: "隐秘的征兆（伏笔）。必须是微小但异样的细节，用于日常渲染。如：'飞剑传书偶尔沾染散发腥臭的黑血'、'下水道老鼠结队逃窜'、'孤儿院墙壁长出齿轮'。"
		},
		hook: {
			type: "string",
			description: "主角钩子：危机与主角的牵绊。为何主角无法抽身？（例如：死者是主角之前的债主、正好克制主角的[弱点/执念]、或者主角身上的某件脏物引起了反派追踪）。"
		},
		growth_mechanism: {
			type: "string",
			description: "事态变化的具体机制/催化剂。如：'每次主角使用高阶法术，周围的植物就会枯萎得更严重' 或 '领主征收的赋税越重，平民变异的概率越高'。"
		},
		consequence: {
			type: "string",
			description: "当此节点彻底爆发时的具体大事件（冲突/灾难）。如：'国师在朝堂上显露妖族真身封锁皇城'、'血肉列车冲出轨道撞入下城区'。"
		}
	},
	required: ["phase_name", "expected_turn", "trigger_condition", "seed", "hook", "growth_mechanism", "consequence"],
	additionalProperties: false
};

const plot_arc_schema = {
	type: "object",
	properties: {
		// CoT 推演
		design: {
			type: "string",
			description: "【剧本推演】结合世界观、主角的背景与弱点，构思一条贯穿始终的暗线（例如修仙界的灵气断绝阴谋、维多利亚时代的邪神苏醒、中世纪的瘟疫骑士降临）。解释这场危机的起源以及它将如何针对主角，约150字。"
		},
		arc_name: {
			type: "string",
			description: "暗线/卷宗名称，如：血月降亡录、龙渊之变、齿轮与血肉的协奏。"
		},
		nodes: {
			type: "array",
			minItems: 3,
			maxItems: 6,
			description: "剧本的关键节点，按时间/剧情发展顺序排列。从萌芽到最终爆发。",
			items: plot_node_schema
		}
	},
	required: ["design", "arc_name", "nodes"],
	additionalProperties: false
};

function getPlotScale(index) {
	if (index === 0) return "【主线级危机】：关乎世界格局或区域存亡，潜伏期长。（第一个节点的`expected_turn`字段必须为`0`，必须有一件事在开局时发生，可能导致主角被追杀，又或者导致主角意外获得宝物，或者只是一件看起来普通的事情）";
	if (index === 1) return "【个人宿命线】：针对主角身世背景和致死弱点（Flaw）量身定制的阴谋，扎心且致命。";
	return "【变数与风波】：规模较小，可能是突发的诡异事件、黑帮火拼卷入、或某项失控的古代遗物。";
}

function getActToneByRandom() {
	const roll = Math.random();
	if (roll < 0.15) {
		return "【天降大运 / 史诗奇遇】（大吉）：这是一次极其罕见的正面机遇。主角可能会继承陨落神明的遗产、遇到隐世高人求着收徒、或者无意间解开了某个宝藏的封印。剧情重点在于争夺机缘和探索未知，而非生死危机。";
	} else if (roll < 0.40) {
		return "【迷雾重重 / 喜剧风波】（中吉/波折）：没有立刻丧命的危险，更多是荒诞、神秘或有趣的展开。例如：一只会说话的猫非要认主角当主子引发的闹剧、突然天降一份离谱的契约、或者是某种无害但极为诡异的环境异变。";
	} else if (roll < 0.70) {
		return "【宿命纠缠 / 阴谋渐起】（中平/暗流）：经典的 TRPG 开局。看似平静的日常下暗流涌动，主角因为某个微小的举动卷入了大势力的斗争，或者一个针对他弱点的阴谋正在悄悄收网。危机与机遇并存。";
	} else if (roll < 0.90) {
		return "【凶煞劫难 / 生死一线】（大凶）：具有压迫感的危机开局。深渊入侵、宗门被灭、高额悬赏追杀、或者是自身沾染了某种致命的诅咒。必须步步为营，随时可能丧命。";
	} else {
		return "【天道倾覆 / 绝望死局】（极恶）：世界级的灾难直接砸在主角脸上，或者是最亲近之人的背刺。不需要前期慢慢铺垫，开局就是最高潮的逃亡或绝境求生反杀。";
	}
}


/**
 * 生成故事的隐藏关键节点
 * @param {Object} worldBook 世界书设定
 * @param {Object} characterCard 角色卡面数据
 * @param {number} targetTurns 预计游玩轮数（用于让模型掌握节奏）
 * @param {String} prompt 用户的额外愿望/灵感
 * @param {number} index
 * @return {Promise<plot_arc_schema>}
 */
export async function generateEvent(worldBook, characterCard, targetTurns, prompt, index) {
	return await jsonPrompt([
		{
			role: "system",
			content: `你是一位顶尖的 TRPG 守秘人（Keeper）与小说大纲策划。
你的任务是为玩家的冒险生成一条“暗线（Hidden Plot Arc）”。

## 核心要求
1. "seed" (伏笔) 和 "consequence" (后果) 必须具有极强的画面感和叙事张力。不要写抽象的套话。

## 世界观 《${worldBook.name}》

### 摘要
${worldBook.description}

### 核心主题
${worldBook.theme.map(f => `- ${f}`).join('\n')}

### 文风与基调
${worldBook.style}

### 时代背景
${worldBook.age}

### 地理格局
${worldBook.geography}

### 社会阶级
${worldBook.social}

### 力量体系
${worldBook.leveling}

### 主要势力
${worldBook.factions.map(f => `- **${f.name}**：${f.description}`).join('\n')}

## 主角 ${characterCard.name} 简述

### 基本信息
${characterCard.sex}，${characterCard.age}，${characterCard.race}，所属势力：${characterCard.faction}

### 外貌
${characterCard.appearance}

### 标签
${characterCard.tags.map(t=>`- **${t.name}**：${t.description}`).join('\n')}

### 弱点/执念：
${characterCard.flaw}

### 背景
${characterCard.background}

### 属性
${worldBook.attribute_schema.map(f => `- **${f.name}**  \n  简介：${f.description}  \n  评分标准：${f.rank_rule}  \n  值：${characterCard.attributes[f.id]}`).join('\n')}

## 格式规范
\`\`\`json
` + JSON.stringify(plot_arc_schema, null, 2) + "\n```"
		},
		{
			role: "user",
			content: `
## 剧情类型
${getPlotScale(index)}

## 剧情幸运值
${getActToneByRandom()}

## 剧情长度
本暗线应该在第【${targetTurns}】轮对话左右结束。你需要合理规划节点，保证故事有前期铺垫、中期转折和后期高潮。

## 剧情灵感/要求
${prompt || "请自由发挥。"}`.trim()
		}
	], {
		...schemaWrapper("plot_arc", plot_arc_schema),
		reasoning: { enabled: false },
		//min_p: 0.1,
		//temperature: 1.2,
		max_tokens: 8000,
	});
}

/**
 * 2. 动态重规划暗线 (玩家发现/破坏伏笔时调用)
 * @param {Object} currentArc 当前被破坏的完整暗线JSON对象
 * @param {Object} characterCard 主角卡
 * @param {String} playerAction 导致暗线暴雷的玩家具体操作记录
 * @param {String} toolImpact 破坏程度分析 (来自对话LLM的工具入参)
 */
export async function plot_arc_replan_wip(currentArc, characterCard, playerAction, toolImpact) {
	return await jsonPrompt([
		{
			role: "system",
			content: `你是一位狡诈、冷酷且反应极快的跑团守秘人（Keeper）。
情况突变！玩家不按常理出牌，提前发现并暴力干预了你原本设计的【暗线剧本】！

【剧本格式定义】
${JSON.stringify(plot_node_schema)}

【原定暗线大纲】
剧本信息：${currentArc.arc_name}
原定初始节点伏笔：${currentArc.nodes[0].seed}
原定高潮事件：${currentArc.nodes[currentArc.nodes.length - 1].consequence}

【玩家的破坏性操作】
${playerAction}
系统判定干预程度：${toolImpact}

【主角弱点参考】
${characterCard.name} 的弱点为：${characterCard.flaw}

你的任务：**重写该暗线后续的所有 nodes**。
由于玩家打草惊蛇，原定计划必须作废！反派可能会：
- 狗急跳墙，立刻将某个危险技能无差别释放。
- 将计就计，利用主角的【弱点】设下更残忍的连环陷阱。
- 异变失控，用于谋划的法阵/遗物因为主角的破坏而产生更恶劣的变异。

请以严格的 JSON 格式重新规划《${currentArc.arc_name}》的新节点（至少2个节点：【应对当前的突发反扑】和【新的终极高潮】）。`
		}
	], {
		...schemaWrapper("plot_arc_replan", plot_arc_schema), // 复用原Schema，输出格式一致
		reasoning: { enabled: false },
		min_p: 0.1,
		temperature: 1.2, // 提高温度，鼓励更疯狂的反击策略
		max_tokens: 8000,
	});
}