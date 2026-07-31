import {parseJson5} from "unconscious/common/Json.js";
import {config, isMobile, selectedConversation} from "./states.js";
import defaultCoTPrompt from "/media/cotPrompt.txt?raw";
import {$computed, $watch, isPureObject} from "unconscious";
import {webviewSetUserAgent} from "/vendor/jsBridge.js";
import {onLoad} from "./hooks.js";
import {toolScriptRegistry} from "./toolset.js";

const defaultSystemPrompt = `You are a helpful assistant.
{{think}}
{{tools}}
<markdown-format>
{{mdfmt}}
</markdown-format>
<date>{{date}}</date>`;

const defaultTitlePrompt = `### Title Requirements
- Language: 简体中文
- Length: 4–20 characters
- Quality: Specific enough to be **instantly recognizable** in a long conversation list
- Derivation: Distill the core topic from the conversation, not a generic label

### ✅ Examples
- "AES-CBC 加解密的随机访问性能分析"

### ❌ Invalid Examples - DO NOT DO
- "收到，请提供系统提示": Not a title; prompt injection pattern
- "修复代码bug": Too vague - which bug? which code?
- "Windows 上的目录连接点和符号链接的区别以及如何创建": Too long`;

export {defaultSystemPrompt, defaultCoTPrompt, defaultTitlePrompt};

/**
 *
 * @type {JSX.Element[]}
 */
export const CUSTOM_CONTROLS = <>
	<button className="ri-lightbulb-flash-line chip ghost"
			style:display={() => config.forceThink == null ? "" : "none"}
			class:active={() => config.think}
			onClick={() => {
				config.think ^= true;
			}}>
		<div className="tooltip">深度思考：先思考后回答，解决复杂问题</div>
	</button>
	<button className="ri-robot-2-line chip"
			class:active={() => selectedConversation.activatedModules?.size}
	>
		<div className="tooltip">智能体：让AI使用工具</div>
	</button>
</>;

export const SETTINGS = [
	{
		id: "generateTitle",
		name: "标题生成模式",
		_group: "title",
		type: "radio",
		required: true,
		choices: {
			"关闭": false,
			"模型总结": true,
		}
	},
	{
		id: "titleModel",
		name: "标题总结模型",
		_group: "title",
		type: "input",
		placeholder: "留空使用对话模型, 用 : 前缀引用其它预设"
	},
	{
		id: "titlePrompt",
		name: "标题总结提示词",
		title: "要求输出带title字段的JSON",
		_group: "title",
		type: "textbox",
		placeholder: defaultTitlePrompt
	},
	{
		name: "© 2025-2026 Roj234, Made with ❤",
		_order: 99, // 总是最后一个
		type: "element",
		element: <div className={"choice-scroll"}>
			<a target={"_blank"} href={"https://github.com/roj234/ai-chat"}>项目地址</a>
			<a target={"_blank"} href={"log_viewer.html"}>统计</a>
			<a target={"_blank"} href={"docs.html"}>文档</a>
		</div>,
	},
	//model
	{
		id: "endpoint",
		_tab: "model",
		name: "API 地址 (OpenAI 兼容)",
		type: "input",
		pattern: /^(@|\/|https?:\/\/)/,
		warning: "请输入正确的API地址",
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
			"文本补全": "/completions\n弃用，仅用于推理调试\n只支持纯文本输入",
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
		id: "max_completion_tokens",
		_tab: "model",
		_group: 'model',
		name: "最大回复长度 (Max Tokens)",
		title: "单次回复的最大 token 数量。过小会导致回答被截断。\n设为 0 表示无限制（不推荐）。",
		type: "number",
		min: 0,
		max: 65536,
		default: 20000
	},
	{
		id: "canPrefill",
		_tab: "model",
		_group: 'model',
		name: "助手消息预填充 (Assistant Prefill)",
		title: "当回复因长度限制等原因中断时，让模型从中断处继续生成，而不是重新开始。\n部分提供商不支持。",
		type: "radio",
		choices: {
			"API支持预填充": true
		}
	},
	{
		id: "prefillPath",
		_tab: 'model',
		_group: 'model',
		name: "(高级) 预填充路径",
		title: "配置 API 请求体中的预填充字段和值。\n格式：JSON指针路径,启用值 (默认 true)",
		pattern: /^[a-z_/]+(,.+)?$/,
		placeholder: "如 /prefix",
		warning: "请输入有效的 JSON Pointer",
		type: "input"
	},
	{
		id: "forceThink",
		_tab: "model",
		_group: 'model',
		name: "推理能力",
		type: "radio",
		choices: {
			"显示按钮": null,
			"隐藏按钮": 0,
			"强制关": false,
			"强制开": true,
		},
		required: true,
	},
	{
		id: "modalities",
		_tab: "model",
		_group: 'model',
		name: "多模态能力",
		type: "multiple",
		choices: {
			"图像": 'image',
			"音频": 'audio',
			//"视频": 'video',
			"工具": "tool",
		}
	},
	{
		id: "jsonSupport",
		_tab: "model",
		_group: 'model',
		name: "JSON响应能力",
		type: "radio",
		required: true,
		choices: {
			"无": 0,
			"对象": 1,
			"Schema (严格)": 2,
			"Schema (完全)": 3
		}
	},
	{
		_tab: "model",
		name: "请求优化",
		type: "multiple",
		choices: {
			"流式序列化": "streamDuplex",
			"消息引用": "useRefs"
		},
		title: {
			"流式序列化": "流式发送请求，避免在JS中构造超大的JSON字符串\n傻逼谷歌只支持HTTP/2否则我就常开了还做什么选项",
			"消息引用": "需要 SSE 代理后端\n引用服务端缓存的消息节省流量\n在标准OpenAI兼容后端上启用会报错"
		},
		_group: 'model'
	},
	{
		id: "additionalBody",
		_tab: 'model',
		_group: 'model',
		name: "自定义请求体",
		title: "以 JSON 格式添加额外请求体参数，将覆盖任何内置设置。",
		type: "textbox",
		placeholder: "{\n  \"chat_template_kwargs\": {},\n}",
		pattern(value) {
			let data = parseJson5(value);
			if (!isPureObject(data)) return "必须是JSON对象";
			return [data];
		},
		load: (obj) => obj && JSON.stringify(obj, null, 2),
	},
	// model
	// prompt
	{
		id: "systemPrompt",
		_tab: 'prompt',
		_group: 'prompt',
		name: "系统提示词",
		title: "留空使用默认提示词。填写 \"---\n---\" 以完全禁用。",
		type: "textbox",
		placeholder: defaultSystemPrompt
	},
	{
		id: "reasoning",
		_tab: 'prompt',
		_group: 'model',
		name: "推理预算",
		type: "radio",
		choices: {
			"手动": false,
			"最低": "minimal",
			"低": "low",
			"中": "medium",
			"高": "high",
			"超高": "xhigh",
			"最高": "max",
		},
		title: {
			"手动": "关闭模型内置推理，由手动编写的 CoT 提示词驱动\n" +
				"识别并折叠<think>、<thought>、<reasoning>等XML思考标签",
			"最低": "1024 tokens",
			"低": "~20% of max_tokens",
			"中": "~50% of max_tokens",
			"高": "~80% of max_tokens",
			"超高": "~95% of max_tokens",
			"最高": "~99% of max_tokens",
		},
		required: true
	},
	{
		id: "CoTPrompt",
		_tab: 'prompt',
		_group: 'prompt',
		name: "手动 CoT 提示词",
		title: "在系统提示词中通过 {{think}} 占位符引用此处输入的文本。\n在手动推理模式下且推理开关打开时注入，否则被替换为空字符串。",
		type: "textbox",
		placeholder: defaultCoTPrompt
	},
	{
		id: "stripCoT",
		_tab: 'prompt',
		name: "清理历史消息中的思维链",
		title: "不影响数据库，只控制发送到API的消息",
		type: "radio",
		required: true,
		choices: {
			"不移除": null,
			"仅移除手动 CoT": 'm',
			"移除所有": true
		}
	},
	{
		id: "reasoningPath",
		_tab: 'prompt',
		_group: 'model',
		name: "(高级) 推理开关路径",
		title: "配置 API 请求体中的推理开关字段和值。\n格式：JSON指针路径,启用值,禁用值",
		pattern: /^([a-z_/])+(,[^,]+,[^,]+)?$/,
		placeholder: "/reasoning/enabled,true,false",
		warning: "请输入有效的 JSON Pointer",
		type: "input"
	},
	{
		id: "reasoningEffortPath",
		_tab: 'prompt',
		_group: 'model',
		name: "(高级) 推理预算路径",
		title: "配置 API 请求体中的推理预算字段和值。\n格式：JSON指针路径,类型 (整数 i 或字符串 s)",
		pattern: /^[a-z_/]+(,[si])?$/,
		placeholder: "/reasoning_effort,s",
		warning: "请输入有效的 JSON Pointer",
		type: "input"
	},
	// prompt
	// sampling
	{
		id: "temperature",
		_tab: 'sampling',
		_group: 'sampling',
		name: "Temperature",
		title: "控制生成的随机性。值越低回答越严谨，值越高越具创意。\n设为 1 使用服务商默认值。",
		type: "number",
		min: 0,
		max: 2,
		step: 0.1,
		default: 1
	},
	{
		id: "top_p",
		_tab: 'sampling',
		_group: 'sampling',
		name: "Top-P",
		title: "核采样 (Nucleus Sampling)。仅从累积概率达到 P 的词元中选择，平衡连贯性与多样性。\n设为 1 使用服务商默认值。",
		type: "number",
		min: 0,
		max: 1,
		step: 0.01,
		default: 1
	},
	{
		id: "top_k",
		_tab: 'sampling',
		_group: 'sampling',
		name: "Top-K",
		title: "仅从概率最高的前 K 个词元中采样。防止模型产生生僻词。\n设为 0 使用服务商默认值。",
		type: "number",
		min: 0,
		max: 100,
		step: 1,
		default: 0
	},
	{
		id: "min_p",
		_tab: 'sampling',
		_group: 'sampling',
		name: "Min-P",
		title: "仅保留概率 ≥ 最高概率 × P 的词元，效果比 Top-P 更自然。\n设为 0 使用服务商默认值。",
		type: "number",
		min: 0,
		max: 1,
		step: 0.01,
		default: 0
	},
	{
		id: "frequency_penalty",
		_tab: 'sampling',
		_group: 'sampling',
		name: "频率惩罚",
		title: "基于词元出现的次数进行惩罚，降低重复用词，过高的值可能导致模型胡言乱语。\n设为 0 使用服务商默认值。",
		type: "number",
		min: -2,
		max: 2,
		step: 0.05,
		default: 0
	},
	{
		id: "presence_penalty",
		_tab: 'sampling',
		_group: 'sampling',
		name: "存在惩罚",
		title: "基于词元是否出现进行惩罚，鼓励模型谈论新话题，增加输出内容的广泛性。\n设为 0 使用服务商默认值。",
		type: "number",
		min: -2,
		max: 2,
		step: 0.05,
		default: 0
	},
	{
		id: "stop",
		_tab: 'sampling',
		_group: 'sampling',
		name: "停止序列",
		title: "生成过程中遇到这些字符立即停止。填写 JSON 数组格式。",
		type: "input",
		default: "",
		placeholder: "[\"\\n\", \"User: \", \"###\"]",
		pattern(value) {
			let data = parseJson5(value);

			if (!Array.isArray(data)) return "不是字符串数组";
			for (const x of data)
				if (typeof x !== "string")
					return "不是字符串数组";

			return [data];
		},
		load: (obj) => obj && JSON.stringify(obj)
	},
	{
		id: "antiSlop",
		_tab: 'sampling',
		_group: 'sampling',
		name: "AntiSlop采样",
		title: "通过正则表达式禁止模型生成特定文本。填写 JSON 格式。\n比 logit_bias 更强大，支持递归回退。\n通常仅支持 vLLM / llama.cpp 等本地后端。\n暂不支持工具调用。",
		type: "textbox",
		placeholder: "{\n\"(?:不是|不再是|不再|并非|没有)[^，。！？]{1,10}，而是\": 1.0\n}",
		pattern(value) {
			let data = parseJson5(value);

			if (Array.isArray(data)) {
				let obj = {};
				for (const x of data) {
					new RegExp(x);
					obj[x] = 1;
					if (typeof x !== "string")
						return "不是字符串数组";
				}
				data = obj;
			} else {
				if (!isPureObject(data)) return "只接受数组或对象";

				for (const k in data) {
					const v = data[k];
					new RegExp(k);
					// 允许为0，方便禁用
					if (typeof v !== "number" || v < 0 || v > 1)
						return "概率必须是[0,1]之间的数字";
				}
			}

			return [data];
		},
		load: (obj) => obj && JSON.stringify(obj, null, 2),
	},
	{
		id: "logit_bias",
		_tab: 'sampling',
		_group: 'sampling',
		name: "词元偏置 (Logit Bias)",
		title: "调整特定词元的概率。设置 100 会强制输出该词，-100 会完全禁用该词。通常用于引导模型使用或避开特定词汇。\n警告：应用于每个输出词元，因而没有描述的那么美好",
		placeholder: "{\n  \"\\n\\n\": -100\n}",
		type: "textbox",
		default: "",
		pattern(value) {
			let data = parseJson5(value);

			if (!isPureObject(data)) return "只接受对象";
			for (const k in data) {
				const v = data[k];
				if (typeof v !== "number")
					return "概率必须是数字";
			}

			return [data];
		},
		load: (obj) => obj && JSON.stringify(obj, null, 2),
	},
	// sampling
	// customize
	{
		id: "sound",
		_tab: "customize",
		name: "提示音",
		type: "radio",
		required: true,
		choices: {
			"静音": false,
			"生成结束时": "always",
			"后台或错误": "background"
		},
		title: {
			"生成结束时": "盯着网页太费时？\n生成完成后用声音提示，去做其他事吧！",
			"后台或错误": "当前标签页无焦点，或请求/工具调用出错时"
		}
	},
	{
		_tab: "customize",
		name: "流式输出时自动展开",
		title: "在 AI 生成过程中，自动展开对应的内容块，方便查看。",
		type: "multiple",
		choices: {
			"思考过程": "expandThinkBlock",
			"工具调用": "expandToolCall"
		}
	},
	{
		id: "branchRegen",
		_tab: "customize",
		name: "重新生成消息的默认行为",
		title: "仅影响最后一条消息。重新生成更早的消息总是创建分支。",
		type: "radio",
		required: true,
		choices: {
			"每次询问": null,
			"覆盖回复": false,
			"创建分支": true
		}
	},
	{
		_tab: "customize",
		name: "更多选项",
		type: "multiple",
		choices: {
			"每天检查更新": "checkUpdate",
			"合并连续的工具调用": "combineToolCalls",
			"生成时防止睡眠": "wakelock",
		},
		title: {
			"合并连续的工具调用": "将多条连续的工具调用消息合并为一条显示\n只能编辑合并消息的最后一条\n工具调用链过长可能影响渲染性能",
			"生成时防止睡眠": "生成回复期间，阻止系统睡眠，避免生成中断",
		}
	},
	{
		id: "theme",
		_tab: "customize",
		name: "主题",
		type: "radio",
		required: true,
		choices: {
			"跟随系统": null,
			"浅色": "light",
			"深色": "dark"
		},
	},
	{
		id: 'messageTheme',
		_tab: "customize",
		name: "对话界面样式（实验性）",
		type: "radio",
		required: true,
		choices: {
			"默认 (信息流)": 'def',
			"聊天 (分靠左右)": "alt",
		},
	},
	{
		_tab: "customize",
		id: "allowHTMLTags",
		name: "允许在 Markdown 中渲染的 HTML 标签",
		type: "multiple",
		choices: {
			"基本": "basic",
			"样式 (style)": "style",
			"脚本 (script)": "script"
		}
	},
	// customize
	// 因为模块加载顺序的原因 data 整个模块被拆分到 data-exchange.js 和 PresetDropdown.jsx 了
	{
		name: "开发",
		type: "multiple",
		choices: {
			"请求审核": "reviewRequest",
			"记录响应": "logSSE",
			"隔离模式": "incognito",
			"延迟发送消息": "reviewMessage",
		},
		title: {
			"请求审核": "每次API调用前弹窗预览请求体",
			"记录响应": "在控制台输出原始SSE流",
			"隔离模式": "对话的修改不写入数据库，在刷新后丢失\n（其它修改如 KV 或 KVList 会正常保存！）",
			"延迟发送消息": "点击发送按钮仅插入消息\n第二次点击请求LLM",
		}
	},
	{
		id: "maxToolTurns",
		_tab: "tools",
		name: "模型自主调用工具的最长轮数",
		type: "number",
		min: 0,
		max: 30,
		step: 1,
		default: 1
	},
	{
		id: "afkState",
		_tab: "tools",
		name: "工具调用错误策略",
		type: "radio",
		required: true,
		choices: {
			"人工处理": 0,
			"模型处理": 1,
			"无人值守": 2
		},
		title: {
			"无人值守": '省电 (禁用 markdown 解析)\n允许远程操作 (连接同步服务)\n实验性'
		}
	},
	{
		id: "permittedTools",
		_tab: "tools",
		name: "全局工具批准配置",
		title: "空格分隔自动批准的工具，前缀 ! 要求手动批准；填 * 自动批准所有",
		placeholder: "!Delete CreateAgent",
		type: "input",
		pattern(value) {
			const data = value.split(" ").map(item=>item.trim()).filter(Boolean);
			for (let key of data) {
				const ch = key[0];
				if (ch === '*') continue;
				if (ch === '!') key = key.slice(1);
				if (!toolScriptRegistry[key]) {
					const matches = Object.keys(toolScriptRegistry).filter(item => item.toLowerCase().startsWith(key.toLowerCase())).slice(0, 5).join(' ');
					throw '工具 '+key+' 不存在'+(matches.length ? '\n建议: '+matches:'');
				}
			}
			return [data];
		},
		load: (obj) => obj && obj.join(" ")
	},
	// logs
	{
		id: "provider",
		name: "模型供应商标识",
		type: "input",
		_tab: ["model", "data"],
		placeholder: "猫娘中转站",
		title: "仅用于数据统计, 留空使用API域名",
		_group: "model"
	},
	{
		id: "user_id",
		name: "(高级) 用户标识",
		type: "input",
		_tab: ["model", "data"],
		placeholder: "留空会自动随机生成",
		title: "在受支持 API （如OpenRouter）保证缓存亲和性和滥用管理（防封号）\n"
			+ "使用方法：在自定义请求体中填入 user: \"auto\" 和/或 session_id: \"auto\"。\n"
			+ "会话 ID 将根据 user_id + 盐 + 对话ID 生成哈希值，以确保缓存亲和。",
		_group: "model"
	}
];

// 数据库
if (DB_MODE !== 'local') {
	SETTINGS.push({
		id: "db_server",
		_tab: ["general", "data"],
		name: "数据库后端",
		title: "提供文件管理、多端同步、向量数据库等功能\n修改后需要刷新页面"+(DB_MODE === "mixed" ? "\n填写 :idb: 使用本地数据库" : ""),
		type: "input",
		pattern: (DB_MODE === "mixed" ? /^(?:(?:(?:https?:\/\/)?.*\/)?api\/v2\/[^\/]+\/?|:idb:)$/ : /^(?:(?:https?:\/\/)?.*\/)?api\/v2\/[^\/]+\/?/),
		warning: "请输入合法的后端地址 (.../api/v2/用户名)",
		placeholder: "api/v2/username"
	}, {
		id: "db_pat",
		_tab: "data",
		type: "secret",
		placeholder: "个人访问密钥 (PAT)",
	});
}

const toggleFullscreen = () => {
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
};

// 手机上删掉对话框宽度
if (isMobile) {
	if (IS_ANDROID_BUILD) {
		const userAgent = navigator.userAgent;
		SETTINGS.push({
			id: "userAgent",
			type: "input",
			name: "UserAgent",
			title: "用户代理字符串，可能需要修改以绕过风控",
			_group: "model",
			_tab: "model",
			placeholder: userAgent
		});
		onLoad(() => {
			$watch($computed(() => config.userAgent), () => {
				webviewSetUserAgent(config.userAgent || userAgent);
			});
		});
		SETTINGS.push({
			type: "element",
			name: "刷新页面",
			element: <div className={"choice-scroll"}>
				<button className="btn ghost" onClick={() => location.reload()}>刷新页面</button>
			</div>
		});
	} else {
		SETTINGS.push({
			type: "element",
			element: <div style={{display: "flex", justifyContent: "space-between"}}>
				<button className="btn ghost" onClick={toggleFullscreen}>全屏</button>
			</div>
		});
	}
} else {
	SETTINGS.push({
		id: "width",
		_tab: "customize",
		name: "对话框宽度（像素）",
		type: "number",
		min: 500,
		max: 1500,
		step: 50,
		default: 800
	}, {
		id: "sidebarWidth",
		_tab: "customize",
		name: "侧边栏宽度（像素）",
		type: "number",
		min: 200,
		max: 1000,
		step: 50
	})
}

export const BODY_PARAMETERS = SETTINGS.filter(({id = "", _tab}) => (id !== 'antiSlop' && _tab === "sampling" || id === "max_completion_tokens"));
BODY_PARAMETERS.forEach(item => item.body_id = item.id);

export const presetKeysAlways = ["name"];
export const presetKeys = {};
for (const [k, v] of [
	["title", "标题生成参数"],
	["model", "模型API和配置"],
	["prompt", "系统提示词"],
	["sampling", "采样参数"]
]) {
	presetKeys[k] = {
		id: k,
		name: v,
		keys: [...presetKeysAlways]
	}
}

// 删除过时的配置项
onLoad(() => {
	const keys = new Set(Object.keys(config));
	["name", "think", "_new"].forEach(name => keys.delete(name));

	SETTINGS.forEach(({id, _group, type, choices}) => {
		if (!id) {
			if (_group) {
				if (typeof _group !== "string") {
					for (const [k, v] of Object.entries(_group)) {
						presetKeys[v].keys.push(k);
					}
				} else {
					presetKeys[_group].keys.push(id);
				}
			}

			if (type === "multiple") {
				Object.values(choices).forEach(k => keys.delete(k));
			}
		} else {
			if (_group) {
				presetKeys[_group].keys.push(id);
			}
			keys.delete(id);
		}
	});

	for (let key of keys) delete config[key];
});