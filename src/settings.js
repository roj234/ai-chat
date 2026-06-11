import {parseJsonLenient} from "unconscious/common/Json.js";
import {clearDatabase, exportConversation, importConversation} from "./data-exchange.js";
import {abortCompletion, config, isMobile, messages, selectedConversation} from "./states.js";
import defaultCoTPrompt from "../media/thinkPrompt.txt?raw";
import {createPreset} from "./components/PresetDropdown.jsx";
import SimpleModal from "./components/SimpleModal.jsx";
import {disableBranches, enableBranches, setLastMessage} from "./utils/BranchManager.js";
import {$computed, $watch, isPureObject, unconscious} from "unconscious";
import {webviewSetUserAgent} from "../vendor/jsBridge.js";
import {onLoad} from "./plugin.js";

const defaultSystemPrompt = `You are a helpful assistant.
{{think}}

<tools>
{{tools}}
<markdown-tools>
- Specify file name when download code fence:
   \`\`\`language:filename
   [content]
   \`\`\`
- Render mermaid:
   \`\`\`mermaid
   [content]
   \`\`\`
</markdown-tools>
</tools>
<information>
- Current date: {{date}}
</information>`;

const defaultTitlePrompt = `基于以下用户-LLM对话内容，生成一个**20字以内**的中文标题，用于对话前端展示。标题需简洁、吸引人、概括核心主题。

要求：
- 标题长度：严格≤20字。
- 风格：中性、专业，避免剧透或偏见。
- 示例：如果对话是“教我做蛋糕”，标题可为“蛋糕制作教程/指南”。`;

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
			style:display={() => config.modalities?.includes("tool") ? "" : "none"}
			class:active={() => config.tools}
			onClick={() => {
				config.tools ^= true;
			}}>
		<div className="tooltip">工具调用：使用工具绘制图表、进行计算</div>
	</button>
	<button className="ri-git-fork-line chip"
			style:display={() => selectedConversation.ready ? "" : "none"}
			class:active={() => selectedConversation.bm_leaf}
			disabled={() => unconscious(abortCompletion)}
			onClick={() => {
				if (!selectedConversation.bm_leaf) {
					SimpleModal({
						title: "是否为当前对话启用分支功能？",
						message: "启用后，部分功能将会与之前版本的预期行为不同\n- 您将无法同时进行多个编辑操作\n- 您将无法删除对话中间的消息\n- 编辑操作将创建新的分支（可在设置中修改）\n- 当前版本和上下文管理（技能、变量等）存在一些兼容性问题",
						onConfirm() {
							messages.value = enableBranches(selectedConversation, messages);
							setLastMessage(messages.at(-1));
						}
					});
				} else {
					SimpleModal({
						title: "是否为当前对话关闭分支功能？",
						message: "关闭后，当前未显示的其它分支对话将被彻底删除，无法撤销",
						onConfirm() {
							messages.value = disableBranches(selectedConversation);
						}
					});
				}
			}}>
		<div className="tooltip">对话分支：保存并探索对话的不同走向</div>
	</button>
</>;

export const SETTINGS = [
	{
		id: "generateTitle",
		name: "总结对话并生成标题",
		_group: "title",
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
		_group: "title",
		type: "input",
		placeholder: "留空使用相同模型"
	},
	{
		id: "titlePrompt",
		name: "标题总结提示词",
		_group: "title",
		type: "textbox",
		placeholder: defaultTitlePrompt
	},
	{
		name: "© 2025-2026 Roj234, Made with ❤",
		_order: 99, // 总是最后一个
		type: "element",
		element: <div className={"choice-scroll"}>
			<a target={"_blank"} href={"https://github.com/roj234/ai-chat"}>开源地址</a>
			<a target={"_blank"} href={"log_viewer.html"}>请求日志</a>
			<a target={"_blank"} href={"docs.html"}>离线文档</a>
		</div>,
	},
	//model
	{
		id: "endpoint",
		_tab: "model",
		name: "API 地址 (OpenAI 兼容)",
		type: "input",
		pattern: /^(\/|https?:\/\/)/,
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
		max: 65536,
		_omit: 0
	},
	{
		id: "canPrefill",
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
		id: "prefillPath",
		_tab: 'model',
		_group: 'model',
		name: "(高级) 助手消息预填充 请求体配置",
		title: "JSONPath,JSON (value)",
		placeholder: "prefix,true",
		type: "input"
	},
	{
		id: "forceThink",
		_tab: "model",
		_group: 'model',
		name: "推理能力",
		title: "覆盖并隐藏【深度思考】开关",
		type: "radio",
		choices: {
			"不能推理": false,
			"仅能推理": true,
			"不存在": 0
		}
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
		type: "radio",
		choices: {
			"流式发送Body": "streamDuplex",
			//"后端发送Blob": "sseBlobProxy"
		},
		title: {
			"流式发送Body": "使用HTTP/2流式发送请求，避免在JS中构造超大的JSON字符串\nHTTP/1其实也支持，但谷歌为了强迫H2普及故意不支持",
			//"后端发送Blob": "使用后端服务的SSE Proxy代替客户端发送Blob\n需要后端"
		},
		_group: 'model'
	},
	{
		id: "additionalBody",
		_tab: 'model',
		_group: 'model',
		name: "自定义请求体",
		title: "以 JSON 格式添加额外请求体参数，将覆盖其它设置。",
		type: "textbox",
		placeholder: "{\n  \"chat_template_kwargs\": {},\n}",
		pattern(value) {
			let data = parseJsonLenient(value);
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
		title: "留空使用默认提示词。\n若想完全禁用，请填入 \"---\\n---\"",
		type: "textbox",
		placeholder: defaultSystemPrompt
	},
	{
		id: "reasoning",
		_tab: 'prompt',
		_group: 'prompt',
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
		_group: 'prompt',
		name: "CoT 提示词 (手动)",
		title: "手动注入的思维链提示，在系统提示中使用 {{think}} 引用。",
		type: "textbox",
		placeholder: defaultCoTPrompt
	},
	{
		id: "stripCoT",
		_tab: 'prompt',
		_group: 'prompt',
		name: "移除历史思维链",
		type: "radio",
		choices: {
			"仅手动 CoT": 'm',
			"所有": true
		}
	},
	{
		id: "reasoningPath",
		_tab: 'prompt',
		_group: 'model',
		name: "(高级) 推理开关 请求体配置",
		title: "JSONPath,JSON (enabled), JSON (disabled)",
		pattern: /^[a-z_.]+(,[^,]+,[^,]+)?$/,
		placeholder: "reasoning.enabled,true,false",
		type: "input"
	},
	{
		id: "reasoningEffortPath",
		_tab: 'prompt',
		_group: 'model',
		name: "(高级) 推理预算 请求体配置",
		title: "JSONPath, 整数预算=i | 字符串 effort=s (默认)",
		pattern: /^[a-z_.]+(,[si])?$/,
		placeholder: "reasoning.effort,s",
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
		_omit: 1
	},
	{
		id: "top_p",
		_tab: 'sampling',
		_group: 'sampling',
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
		_group: 'sampling',
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
		_group: 'sampling',
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
		_group: 'sampling',
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
		_group: 'sampling',
		name: "存在惩罚",
		title: "基于词元是否出现过进行惩罚（出现即罚），鼓励模型谈论新话题，增加输出内容的广泛性。\n范围：-2.0 到 2.0。\n设为 0 使用服务商默认值。",
		type: "number",
		min: -2,
		max: 2,
		step: 0.05,
		_omit: 0
	},
	{
		id: "stop",
		_tab: 'sampling',
		_group: 'sampling',
		name: "停止序列",
		title: "生成过程中遇到这些字符立即停止。填写 JSON 数组格式。",
		type: "input",
		_omit: "",
		placeholder: "[\"\\n\", \"User: \", \"###\"]",
		pattern(value) {
			let data = parseJsonLenient(value);

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
			let data = parseJsonLenient(value);

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
		title: "手动调整特定词元的概率。设置 100 会强制输出该词，-100 会完全禁用该词。通常用于引导模型使用或避开特定词汇。\n警告：先问 LLM 这个参数的具体含义，切勿直接修改，否则你会后悔的",
		placeholder: "{\n  \"\\n\\n\": -100\n}",
		type: "textbox",
		_omit: "",
		pattern(value) {
			let data = parseJsonLenient(value);

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
		_tab: "customize",
		name: "分支对话模式 (实验性)",
		type: "multiple",
		choices: {
			"新对话默认开启": "branchModeDefault",
			"允许编辑消息历史": "branchEditHistory"
		},
		title: {
			"允许编辑消息历史": "点击编辑时弹窗询问是否直接编辑消息历史，而不是创建分支"
		}
	},
	{
		_tab: "customize",
		name: "其它选项",
		type: "multiple",
		choices: {
			"上滑隐藏输入框": "uiAutoHideInput",
			"合并连续的工具调用": "combineToolCalls",
			"定期检查更新": "checkUpdate"
		},
		title: {
			"合并连续的工具调用": "将多条工具调用消息合并为一条 (仅影响渲染)\n无法编辑合并的对话"
		}
	},
	{
		_tab: "customize",
		id: "allowHTMLTags",
		name: "解析HTML标签",
		type: "multiple",
		choices: {
			"基础": "basic",
			"样式": "style",
			"代码（危险！）": "script"
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
		name: "导入对话、预设、备份及更多格式",
		element: <div className={"choice-scroll"}>
			<label className="btn ghost">导入
				<input type="file" accept="application/zip,application/json,image/png" style="display:none;" multiple onChange={importConversation}/>
			</label>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => exportConversation(1)}>备份对话</button>
			<button className="btn ghost" onClick={() => exportConversation(2)}>备份预设</button>
			<button className="btn ghost" onClick={() => exportConversation(7)}>备份所有</button>
		</div>
	},
	{
		type: "element",
		_tab: ["general", "data"],
		name: "将当前配置保存为新预设",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => createPreset()}>新预设</button>
		</div>
	},
	{
		type: "element",
		_tab: "data",
		name: "清除所有数据",
		element: <div className={"choice-scroll"}>
			<button className="btn danger" onClick={clearDatabase}>删库</button>
		</div>
	},
	// data
	{
		name: "开发",
		type: "multiple",
		choices: {
			"请求调试": "reviewRequest",
			"响应调试": "logSSE",
			"数据库只读": "incognito",
			"延迟提交消息": "reviewMessage",
		},
		title: {
			"请求调试": "预览发送到API的原始请求体",
			"响应调试": "在控制台记录原始SSE流",
			"数据库只读": "无痕模式：跳过数据库写入，用于调试渲染或测试推理",
			"延迟提交消息": "点击发送按钮仅追加用户消息，第二次点击时请求LLM",
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
	// logs
	{
		id: "provider",
		name: "模型渠道",
		type: "input",
		_tab: "data",
		title: "仅用于统计, 留空使用预设名称",
		_group: "model"
	}
];

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
	const index = SETTINGS.findIndex(({id}) => id === "width");
	if (IS_ANDROID_BUILD) {
		const userAgent = navigator.userAgent;
		SETTINGS[index] = {
			id: "userAgent",
			type: "input",
			name: "UserAgent",
			title: "用户代理字符串，可能需要修改以绕过风控",
			_group: "model",
			_tab: "model",
			placeholder: userAgent
		};
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
		SETTINGS[index] = {
			type: "element",
			element: <div style={{display: "flex", justifyContent: "space-between"}}>
				<button className="btn ghost" onClick={toggleFullscreen}>全屏</button>
			</div>
		};
	}
}

export const BODY_PARAMETERS = SETTINGS.filter(({id = "", _tab}) => (id !== 'antiSlop' && _tab === "sampling" || id === "max_tokens"));
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
requestIdleCallback(() => {
	const keys = new Set(Object.keys(config));
	["name", "think", "tools", "_new"].forEach(name => keys.delete(name));

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