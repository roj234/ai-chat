import {registerDefaultTools} from "/src/skills.js";
// 故事机 (预览版)
import "./rpg/example/StoryEngine.js";
import "./cmdSetPrompt.js";

// Blob ServiceWorker 缓存
import "./blobCache.js";

// JSON对话编辑器
import "./conversationEditor.js";

// 无痕模式弹窗提醒
import "./incognitoToast.js";

// Blob管理器
import "./BlobManager.js";
// 预设快速切换菜单
import "./ModelFastSwitch.js";
// 记忆工具
import "./tools/memory.js";
// 对话建议工具
import "./tools/followupSuggestions.js";

// 搜索消息
import "./search.js";
// 切换数据库服务器时同步本地配置
import "./configSync.js";

// 文件系统和Agent工具组 (use:workspace_files / run_process)
import "./tools/agent.js";
// 图表工具 (use:chart)
import "./tools/chart.js";
// 角色扮演工具组 (use:interactive_simulation)
import "./tools/rp_kit/interactive_simulation.js";
// 图片缩放工具 (use:zoom_in)
import "./tools/zoom_in.js";
// 代码解释器工具 (use:code_interpreter)
// 注意目前只能用JS，如果想用Python可以看看Pyoxide
import "./tools/interpreter.js";
// 文生图和TTS插件，ComfyUI端点的工作流模板在 /media 文件夹
import "./tools/media_generator.js";

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

// 角色扮演插件 支持导入预设和角色卡
import "./rp_basic/BasicRoleplay.js";

// 项目管理工具，让模型安排并完成任务 (未实现)
//import "./TodoList.js";
// 插件注册表

// 下面的静态导入完全可以变成动态导入，就看我愿不愿意了
export const onPluginLoaded = Promise.resolve();

if (import.meta.env.DEV) {
	// 测试 skills
	// registerSkill(testSkill);
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
