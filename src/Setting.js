import {exportConversation, importConversation} from "./data-exchange.js";

export const SETTING_CONFIG = [
	{
		id: "endpoint",
		name: "API端点",
		type: "input",
		pattern: /^https?:\/\//,
		warning: "请输入合法的API端点",
		placeholder: "https://api.example.com/v1"
	},
	{
		id: "accessToken",
		name: "AccessToken",
		type: "secret",
		placeholder: "sk-"
	},
	{
		name: "本地浏览器存储。不会发送到第三方。"
	},
	{
		id: "mode",
		name: "模式",
		type: "radio",
		choices: {
			"聊天/Chat": 'chat',
			"补全/Instruct": 'completion'
		},
		required: true
	},
	{
		id: "template",
		name: "提示词模板",
		type: "textbox",
		placeholder: "// 示例：将消息转换为字符串\nmessages => messages.map(m => `${m.role}: ${m.content}`).join('\\n\\n')",
		warning: "要求：返回字符串的函数，参数为 messages: [{role: 'user' | 'assistant' | 'system', content: string}] 数组"
	},
	{
		id: "model",
		name: "模型",
		type: "input",
		placeholder: "auto"
	},
	{
		id: "temperature",
		name: "Temperature",
		type: "number",
		min: 0,
		max: 2,
		step: 0.1
	},
	{
		id: "maxTokens",
		name: "Max Tokens",
		type: "number",
		min: 0,
		max: 16384
	},
	{
		id: "stop",
		name: "Stop Sequences (逗号分隔)",
		type: "input",
		placeholder: "如: \\n, User: "
	},
	{
		id: "systemPrompt",
		name: "System Prompt",
		type: "textbox",
		placeholder: "Response in query's language."
	},
	{
		id: "thinkPrompt",
		name: "手动CoT提示词 (以 {{think}} 引用)",
		type: "textbox",
		placeholder: "Suppose you're a highly capable reasoning model..."
	},
	{
		id: "reasoning",
		name: "思考深度",
		type: "radio",
		choices: {
			"手动": false,
			"最低": "minimal",
			"低": "low",
			"中": "medium",
			"高": "high",
		},
		required: true
	},
	{
		id: "titleModel",
		name: "标题总结模型",
		type: "input"
	},
	{
		name: "按钮",
		type: "multiple",
		choices: {
			"文本视图": "edit",
			"调试模式": "debug",
			"总结标题": "generateTitle",
			"参数强制": "enforceParam",
			"保留思考": "keepReasoning"
		}
	},
	{
		type: "element",
		element: <>
			<button id="exportBtn" className="btn ghost" title="导出当前会话" onClick={exportConversation}>导出</button>
			<label className="btn ghost" title="导入会话JSON">导入
				<input id="importFile" type="file" accept="application/json" style="display:none;" onChange={importConversation}/>
			</label>
		</>
	},
	{
		id: "width",
		name: "窗口宽度",
		type: "number",
		min: 500,
		max: 1500,
		step: 50
	}
];
