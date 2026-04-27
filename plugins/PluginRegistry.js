import {registerDefaultTools, registerSkill} from "/src/skills.js";
// 插件注册表

// 下面的静态导入完全可以变成动态导入，就看我愿不愿意了
export const onPluginLoaded = Promise.resolve();

// 文件系统和Agent工具组 (use:fs)
import "./tools/filesystem.js";
// 图表工具 (use:chart)
import "./tools/ChartCreator.js";
// 角色扮演工具组 (use:roleplay) !WIP!
import "./tools/rp_kit/roleplay.js";
// 图片缩放工具 (use:zoom)
import "./tools/zoom.js";
// 代码解释器工具 (use:interpreter)
// 注意目前只能用JS，如果想用Python可以看看Pyoxide
import "./tools/interpreter.js";
// 文生图和TTS插件，ComfyUI端点的工作流模板在 /media 文件夹
import "./tools/txt2any.js";

// Mermaid流程图插件，如果你禁用，请
// 1. 删除 /public 文件夹中的minfied js
// 2. 修改默认的系统提示词避免LLM继续使用mermaid
import "./mermaid.js";
// 连接测试插件，测试端点是否可用
import "./testConnection.js";
// Llama.cpp插件，支持在UI内加载和卸载模型
import "./llamaCpp.js";
// 全局背景图
import "./customBackground.js";
// 自动补全模型ID
import "./modelIdCompletion.js";

// SillyTavern-兼容 角色扮演插件 支持导入预设和角色卡
import "./st/SillyTavern.js";

// 项目管理工具，让模型安排并完成任务 (未实现)
//import "./TodoList.js";

import testSkill from "/media/TEST.md?raw";

if (import.meta.env.DEV) {
	// 测试 skills
	registerSkill(testSkill);
	// 这个大概是不会完工？
	import ("./rpg/RPG.js");
}

registerDefaultTools([{
	name: "get_time",
	description: "获取当前时间",
	script(parameters, response) {
		return new Date().toString();
	}
}]);
