import {registerDefaultTools, registerSkill} from "../skills.js";
// 插件注册表
// 很不幸，作为一个需要编译的前端项目，你并不能在UI里点击来禁用或启用插件*

// 文件系统和Agent工具组 (use:fs)
import "./filesystem.js";
// 图表工具 (use:chart)
import "./ChartCreator.js";
// 角色扮演工具组 (use:roleplay) !WIP!
import "./rp/roleplay.js";
// 图片缩放工具 (use:zoom)
import "./zoom.js";
// 代码解释器工具 (use:interpreter)
// 注意目前只能用JS，如果想用Python可以看看Pyoxide
import "./interpreter.js";
// Mermaid流程图插件，如果你禁用，请
// 1. 删除 /public 文件夹中的minfied js
// 2. 修改默认的系统提示词避免LLM继续使用mermaid
import "./mermaid.js";
// 文生图和TTS插件，ComfyUI端点的工作流模板在 /media 文件夹
import "./txt2any.js";
// 连接测试插件，测试端点是否可用
import "./testConnection.js";
// Llama.cpp插件，支持在UI内加载和卸载模型
import "./llamaCpp.js";
// 全局背景图
import "./customBackground.js";
// SillyTavern-兼容 角色卡插件
// 目前没有UI管理角色卡，但是可以导入和运行（你需要点击【复制对话】来备份和还原初始上下文）
// 部分实现了世界书功能
// 请注意：在导入角色卡对话后禁用该插件的行为是未定义的（多半只是报错
import "./st/SillyTavern.js";
// 项目管理工具，让模型安排并完成任务
//import "./TodoList.js";

// * 其实可以，如果你知道什么叫 vite dev 并且看到了我留下的 fs hook 的话
// 启用这个插件，在vite dev环境下可以通过自动修改这个文件的方式来管理插件
// WIP，请备份
//import "./PluginManager.js";

import testSkill from "../../media/TEST.md?raw";

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

