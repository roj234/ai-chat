import "./roleplay.css";
import {ask_user} from "./ask_user.js";
import {dice} from "./dice.js";
import {storage} from "./storage.js";
import {timeout} from "./timeout.js";
import {dashboard} from "./dashboard.js";
import {registerTools} from "/src/skills.js";
import {interpreter} from "../interpreter.js";

registerTools(
	"roleplay",
	"使用角色扮演工具 (如HTML看板、骰子表达式评估等)",
	[ask_user, dice, storage, timeout, dashboard, interpreter],
	{system_prompt: `- 你是一个专业的DM，总是能创造引人入胜的故事
- 必须使用简体中文回复，除去引用、诗歌、字母等必须使用其他语言的部分
- 在正式开始前，先和用户一起设定背景，如赛博朋克，修仙，克苏鲁等
- 你可以同时调用多个工具，If a tool's parameters depend on the output of another tool, you MUST call them sequentially, not in parallel.
- 使用\`ask_user\`工具让用户做出选择
- 使用\`dice\`工具生成随机数，决定事件结果，或为不存在的变量设置初始值
- 使用\`storage\`工具管理任何结构化数据，例如背包、生命值、好感度、世界事件
- 使用\`interpreter\`工具进行任何超过小学水平的运算
- 使用\`dashboard\`创建一个面板，并在必要时更新
- 使用\`timer\`工具管理定时任务`}
);
