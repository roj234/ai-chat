import {clearDatabase, duplicateConversation, exportConversation, importConversation} from "./data-exchange.js";
import {createPreset} from "./components/PresetDropdown.jsx";
import {config, isMobile} from "./states.js";
import defaultCoTPrompt from "../media/thinkPrompt.txt?raw";

const defaultSystemPrompt =`You are a helpful assistant.
{{think}}

<markdown-tools>
- 指定代码块下载时的文件名：
   \`\`\`language:filename
   [content]
   \`\`\`
- 渲染 Mermaid 图表：
   \`\`\`mermaid
   [content]
   \`\`\`
</markdown-tools>
<information>
- 现在是${new Date().toLocaleDateString()}
</information>`;

export {defaultSystemPrompt, defaultCoTPrompt};

export const SETTINGS = [
	{
		id: "generateTitle",
		name: "总结对话并生成标题",
		type: "radio",
		required: true,
		choices: {
			"关闭": false,
			"使用模型": true,
			"使用工具调用": "tool"
		}
	},
	{
		id: "titleModel",
		name: "标题总结模型",
		type: "input",
		placeholder: "留空使用主模型"
	},
	{
		name: "个人自用95新项目，欢迎提交bug和功能建议",
		_order: 99, // 总是最后一个
		type: "element",
		element: <a href={"https://github.com/roj234/ai-chat"} target={"_blank"}>&copy; 2025-2026 Roj234</a>
	},
	//model
	{
		id: "endpoint",
		_tab: "model",
		name: "API 地址 (OpenAI 兼容)",
		type: "input",
		pattern: /^https?:\/\/.+\/v1$/,
		warning: "必须以 http(s):// 开头并以 /v1 结尾",
		placeholder: "https://api.openai.com/v1",
		_group: 'model'
	},
	{
		id: "accessToken",
		_tab: "model",
		name: "API 密钥",
		type: "secret",
		placeholder: "sk-...",
		_group: 'model'
	},
	{
		id: "model",
		_tab: "model",
		name: "模型 ID",
		type: "input",
		placeholder: "支持从提供商补全",
		_group: 'model'
	},
	{
		id: "mode",
		_tab: "model",
		name: "工作模式",
		type: "radio",
		choices: {
			"聊天补全": 'chat',
			"文本补全": 'completions'
		},
		title: {
			"聊天补全": "/chat/completions",
			"文本补全": "/completions\n大部分闭源模型不提供此API",
		},
		required: true,
		_group: 'model'
	},
	{
		id: "template",
		_tab: "model",
		_group: 'model',
		name: "聊天模板 (Chat Template)",
		title: "将消息对象数组转换为字符串的 JavaScript 函数，类似 chat_template.jinja。",
		type: "textbox",
		placeholder: "messages.map(m => `${m.role}: ${m.content}`).join('\\n\\n')+'\\n\\nassistant: '",
		warning: "要求：返回字符串的函数，参数为 messages: [{role: 'user' | 'assistant' | 'system', content: string}] 数组"
	},
	{
		id: "max_tokens",
		_tab: "model",
		_group: 'model',
		name: "最大回复长度 (Max Tokens)",
		title: "单次回复的最大 token 数量。过小会导致回答被截断。\n如服务商支持，可启用‘助手消息预填充’。\n设为 0 表示无限制（不推荐）。",
		type: "number",
		min: 0,
		max: 16384,
		omit: 0
	},
	{
		id: "allowContinue",
		_tab: "model",
		_group: 'model',
		name: "助手消息预填充 (Assistant Prefill)",
		title: "当回复因长度限制等原因中断时，让模型从中断处继续生成，而不是重新开始。\n部分服务商不支持。",
		type: "radio",
		choices: {
			"API支持预填充": true
		}
	},
	{
		id: "forceThink",
		_tab: "model",
		_group: 'model',
		name: "模型思考限制",
		title: "覆盖并隐藏【深度思考】开关",
		type: "radio",
		choices: {
			"不支持思考": false,
			"仅支持思考": true
		}
	},
	{
		id: "modalities",
		_tab: "model",
		_group: 'model',
		name: "多模态输入限制 (未实现)",
		type: "multiple",
		choices: {
			"图像": 'image',
			"音频": 'audio',
		}
	},
/*	{
		id: "prefillKVCache",
		_tab: "model",
		_group: 'model',
		name: "我的本地LLM很卡 (请看tooltip)",
		title: "在生成完一轮对话之后立即让llama.cpp填充KV缓存\n当思考开启时能加速\n如果你的 prompt 处理速度（不是生成速度）超过三位数 TPS，那么这个选项没有意义",
		type: "radio",
		choices: {
			"预处理Prompt": true
		}
	},*/
	// model
	// prompt
	{
		id: "systemPrompt",
		_tab: 'prompt',
		_group: 'preset',
		name: "系统提示词",
		title: "留空使用默认提示词。\n若想完全禁用，请填入 \"---\\n---\"",
		type: "textbox",
		placeholder: defaultSystemPrompt
	},
	{
		id: "reasoning",
		_tab: 'prompt',
		_group: 'preset',
		name: "推理预算",
		type: "radio",
		choices: {
			"手动": false,
			"最低": "minimal",
			"低": "low",
			"中": "medium",
			"高": "high",
		},
		title: {
			"手动": "基于 CoT 提示词而非模型自身",
			"最低": "1024 tokens",
			"低": "~20% of max tokens",
			"中": "~50% of max tokens",
			"高": "~80% of max tokens",
		},
		required: true
	},
	{
		id: "CoTPrompt",
		_tab: 'prompt',
		_group: 'preset',
		name: "CoT 提示词 (手动)",
		title: "手动注入的思维链提示，在系统提示中使用 {{think}} 引用。",
		type: "textbox",
		placeholder: defaultCoTPrompt
	},
	{
		id: "trimCoT",
		_tab: 'prompt',
		_group: 'preset',
		name: "移除历史思维链",
		type: "radio",
		choices: {
			"仅手动 CoT": 'm',
			"所有": true
		}
	},
	// prompt
	// sampling
	{
		id: "temperature",
		_tab: 'sampling',
		_group: 'preset',
		name: "Temperature",
		title: "控制生成的随机性。值越低回答越严谨，值越高越具创意。\n设为 1 使用服务商默认值。",
		type: "number",
		min: 0,
		max: 2,
		step: 0.1,
		_omit: 1
	},
	{
		id: "top_p",
		_tab: 'sampling',
		_group: 'preset',
		name: "Top-P",
		title: "核采样 (Nucleus Sampling)。仅从累积概率达到 P 的词元中选择，平衡连贯性与多样性。\n设为 1 使用服务商默认值。\n推荐值 0.95。",
		type: "number",
		min: 0,
		max: 1,
		step: 0.01,
		_omit: 1
	},
	{
		id: "top_k",
		_tab: 'sampling',
		_group: 'preset',
		name: "Top-K",
		title: "仅从概率最高的前 K 个词元中采样。防止模型产生生僻词。\n设为 0 使用服务商默认值。\n推荐值 5-20。",
		type: "number",
		min: 0,
		max: 100,
		step: 1,
		_omit: 0
	},
	{
		id: "min_p",
		_tab: 'sampling',
		_group: 'preset',
		name: "Min-P",
		title: "仅保留概率 ≥ 最高概率 × P 的词元，效果比 Top-P 更自然。\n设为 0 使用服务商默认值。\n推荐值 0.1-0.2。",
		type: "number",
		min: 0,
		max: 1,
		step: 0.01,
		_omit: 0
	},
	{
		id: "frequency_penalty",
		_tab: 'sampling',
		_group: 'preset',
		name: "频率惩罚",
		title: "基于词元已出现的次数进行惩罚，降低重复用词，防止重复短语，但过高的值可能导致模型胡言乱语。\n范围：-2.0 到 2.0。\n设为 0 使用服务商默认值。",
		type: "number",
		min: -2,
		max: 2,
		step: 0.05,
		_omit: 0
	},
	{
		id: "presence_penalty",
		_tab: 'sampling',
		_group: 'preset',
		name: "存在惩罚",
		title: "基于词元是否出现过进行惩罚（出现即罚），鼓励模型谈论新话题，增加输出内容的广泛性。\n范围：-2.0 到 2.0。\n设为 0 使用服务商默认值。",
		type: "number",
		min: -2,
		max: 2,
		step: 0.05,
		_omit: 0
	},
	{
		id: "stop#",
		_tab: 'sampling',
		_group: 'preset',
		name: "停止序列",
		title: "生成过程中遇到这些字符立即停止。填写 JSON 数组格式。",
		type: "input",
		placeholder: "[\"\\n\", \"User: \", \"###\"]"
	},
	{
		id: "antiSlop#",
		_tab: 'sampling',
		_group: 'preset',
		name: "反语法约束",
		title: "通过正则表达式禁止模型生成特定文本。填写 JSON 格式。\n比 logit_bias 更强大，支持递归回退。\n通常仅支持 vLLM / llama.cpp 等本地后端。\n暂不支持工具调用。",
		type: "textbox",
		placeholder: "{\n\"(?:不是|不再是|不再|并非|没有)[^，。！？]{1,10}，而是\": 1.0\n}"
	},
	{
		id: "logit_bias#",
		_tab: 'sampling',
		_group: 'preset',
		name: "词元偏置 (Logit Bias)",
		title: "手动调整特定词元的概率。设置 100 会强制输出该词，-100 会完全禁用该词。通常用于引导模型使用或避开特定词汇。\n警告：先问 LLM 这个参数的具体含义，切勿直接修改，否则你会后悔的",
		placeholder: "{\n  \"\\n\\n\": -100\n}",
		type: "textbox"
	},
	{
		id: "additionalBody#",
		_tab: 'sampling',
		_group: 'preset',
		name: "自定义请求体",
		title: "以 JSON 格式添加额外请求体参数，将覆盖其它设置。",
		type: "textbox",
		placeholder: "{\n  \"chat_template_kwargs\": {},\n}"
	},
	// sampling
	// customize
	{
		id: "sound",
		_tab: "customize",
		name: "完成通知音效",
		type: "radio",
		choices: {
			"关": false,
			"开": "always",
			"后台或错误": "background"
		}
	},
	{
		_tab: "customize",
		name: "流式响应时，自动展开某些块",
		type: "multiple",
		choices: {
			"思考": "expandThinkBlock",
			"工具调用": "expandToolCall"
		}
	},
	{
		id: "width",
		_tab: "customize",
		name: "对话框宽度",
		type: "number",
		min: 500,
		max: 1500,
		step: 50
	},
	// customize
	// data
	{
		type: "element",
		_tab: ["general", "data"],
		_id: "import",
		name: "导入对话、预设及更多格式",
		element: <div className={"choice-scroll"}>
			<label className="btn ghost">导入
				<input type="file" accept="application/zip,application/json,image/png" style="display:none;" multiple onChange={importConversation}/>
			</label>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		name: "导出选中对话（未选中则全部）或预设（可能含密钥）",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => exportConversation(false)}>导出对话</button>
			<button className="btn ghost" onClick={() => exportConversation(true)}>导出预设</button>
			{/*<button className="btn ghost" onClick={() => exportConversation(true)}>导出所有</button>*/}
		</div>
	},
	{
		type: "element",
		//_tab: "data",
		name: "复制选中的对话",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={duplicateConversation}>另存为</button>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		name: "将当前配置保存为新预设",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => createPreset()}>新预设</button>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		name: "清除所有数据（不可恢复）",
		element: <div className={"choice-scroll"}>
			<button className="btn danger" onClick={clearDatabase}>删除数据库</button>
		</div>
	},
	// data
	{
		name: "开发",
		type: "multiple",
		choices: {
			"请求调试": "debugRequest",
			"响应调试": "debug",
			"数据库只读": "debugDatabase",
		},
		title: {
			"请求调试": "预览发送到API的原始请求体",
			"响应调试": "在控制台打印SSE流，手动执行工具调用",
			"数据库只读": "数据库修改在刷新后重置",
		}
	},
	{
		id: "maxToolTurns",
		_tab: "tools",
		name: "模型连续调用工具（无需人工确认）的最长轮数",
		type: "number",
		min: 0,
		max: 30,
		step: 1
	},
	{
		id: "permitAllTools",
		_tab: "tools",
		name: "自动批准工具调用，比如 'rm -rf /'",
		type: "radio",
		choices: {
			"YOLO模式": true
		}
	},
];

function toggleFullscreen() {
	let elem = document.body;

	if (!document.fullscreenElement) {
		elem.requestFullscreen().catch((err) => {
			alert(`尝试启用全屏模式时出错：${err.message}（${err.name}）`);
		});
		screen.orientation?.lock('portrait-primary');
	} else {
		document.exitFullscreen();
		screen.orientation?.unlock();
	}
}

// 手机上删掉对话框宽度
if (isMobile) {
	const index = SETTINGS.findIndex(({id}) => id === "width");
	SETTINGS[index] = {
		type: "element",
		element: <div style={{display: "flex", justifyContent: "space-between"}}>
			<button className="btn ghost" onClick={toggleFullscreen}>全屏</button>
		</div>
	};
}

export const BODY_PARAMETERS = SETTINGS.filter(({id = "", _tab}) => (_tab === "sampling" && !id.endsWith("#")) || id === "max_tokens");
BODY_PARAMETERS.forEach(item => item.body_id = item.id.replaceAll(/[^a-zA-Z09-_]/g, '').trim());

// 三个等级：Config Model Preset 虽然还没怎么实装
const modelKeys = [];
const presetKeys = ["name", "think", "tools"];
const configKeys = [];
const FLAG = true;

SETTINGS.forEach(({id, _group, choices}) => {
	if (!id) {
		if (_group) for (const [k, v] of Object.entries(_group)) {
			(v === 'preset' || FLAG ? presetKeys : modelKeys).push(k);
		}
		if (choices) configKeys.push(...Object.values(choices));
	} else {
		if (_group) {
			(_group === 'preset' || FLAG ? presetKeys : modelKeys).push(id);
		}
		configKeys.push(id);
	}
});

/** @type {Set<string>} */
export const
	MODEL_KEYS = new Set(modelKeys),
	PRESET_KEYS = new Set(presetKeys),
	CONFIG_KEYS = new Set(configKeys.filter(name => !modelKeys.includes(name) && !presetKeys.includes(name)));

// 删除过时的配置项
requestIdleCallback(() => {
	const keys = new Set(["name", "think", "tools"]);
	for (let el of SETTINGS) {
		if (el.id) {
			keys.add(el.id);
		} else if (el.type === "multiple") {
			Object.values(el.choices).forEach(k => keys.add(k));
		}
	}
	for (let key of Object.keys(config)) {
		if (!keys.has(key)) {
			delete config[key];
		}
	}
});