import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import {jsHide} from "./utils.js";

function removeBrainDiv(driver) {
	jsHide(setting);
	driver.moveNext();
}

const buttons = ["next", "close"];

const mainPageDriver = driver({
	showProgress: true,
	progressText: "{{current}} / 3", // 假装只有3步
	nextBtnText: "继续 &rarr;",
	prevBtnText: "&larr; 返回",
	doneBtnText: "结束",
	showButtons: buttons,

	overlayClickBehavior: () => {},
	onDestroyStarted: () => {
		if (mainPageDriver.getActiveIndex() === 0) {
			removeBrainDiv(mainPageDriver);
			mainPageDriver.moveTo(2);
			return;
		}

		mainPageDriver.destroy();
		localStorage[APP_NAME+':tour-completed'] = APP_VERSION;
	},

	steps: [
		{ element: '#brain', popover: {
			title: '欢迎使用AiChat', description: '<b>连接脑子</b><br/>请先在此处填写您的API地址、密钥和模型名称<br/>模型名称支持从API自动补全',

			onNextClick(element, step, {driver}) {
				removeBrainDiv(driver);
			}
		} },
		{ element: '.controls > .ri-attachment-2', popover: {
			title: '多媒体附件', description: '音频，图片，以及文本文档<br/>' +
					'暂不支持PDF（这毕竟是个前端项目）<br/>' +
					'暂不支持语音聊天',
			showButtons: ["next"]
		} },
		{
			element: '.logo > span:nth-child(1)',
			popover: {
				title: '✅ 准备就绪',
				description: '你现在可以开始聊天了，点击右上角结束教程！<br/>' +
					'请注意：使用本软件需求你有一定的计算机知识，例如知道<code>\\n</code>是回车<br/>' +
					'<br/>' +
					'<b>想要变强吗？</b>剩余步骤将带你速览设置中的高级功能（逆向约束采样、手动CoT、工具元数据等），约需 3-5 分钟。<br/>' +
					'在继续之前，确保你知道<code>Logits</code>是一个张量，<code>tool_calls</code>是OpenAI对话补全API的一个参数<br/>' +
					'<br/>' +
					'现在结束，你也可以在以后查看设置项的悬浮提示',

				onNextClick(element, step, {driver}) {
					driver.getConfig().progressText = "{{current}} / {{total}}";
					driver.moveNext();
				}
			}
		},
		{ element: '.controls > button:nth-child(2)', popover: {
			title: '假设您对LLM前后端和内部机制有充分的了解', description: '点击工具调用将会启用系统内置或插件提供的工具<br/>' +
					'一旦模型调用过工具，后续不建议禁止工具调用，否则可能出现意料之外的结果<br/>' +
					'你可以在系统提示词中（通过本项目提供的扩展格式）允许或禁止模型使用某些工具',
			onNextClick(element, step, {driver}) {
				jsHide(setting);
				switchTab("general").then(() => driver.moveNext());
			}
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="generateTitle"]', popover: {
			title: '生成对话标题', description: '当LLM完成新对话的第一条消息时，让它总结你们的对话并生成标题'
		} },
		{ element: '#settingDialog .filter > div:nth-child(3)', popover: {
			title: '导入数据', description: '导入之前导出的数据，或插件支持的格式<br/>' +
					'例如官方的SillyTavern插件可以导入酒馆的V2角色卡规范(json/png)',
		} },
		{ element: '#settingDialog .filter > div:nth-child(4)', popover: {
			title: '另存为', description: '与你的想象可能不太一样，这个按钮的功能是将目前选中的对话复制一份，因为该项目尚不支持对话分支',
			onNextClick(element, step, {driver}) {
				switchTab("model").then(() => driver.moveNext());
			}
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="mode"]', popover: {
			title: '选择工作模式', description: '我们建议使用对话API<br/>' +
					'大部分模型也只支持对话API<br/>' +
					'使用文本补全API需要你会JavaScript，懂一定的Jinja2模板'
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="allowContinue"]', popover: {
			title: '“继续”消息', description: '回复预填充 (Assistant Message Prefill)<br/>' +
					'你可以随时点击发送按钮【中止】和【继续】LLM的回复<br/>' +
					'闭源模型可能不支持<br/>' +
					'llama.cpp 不支持思考模式的预填充，除了我的分支',
			onNextClick(element, step, {driver}) {
				switchTab("prompt").then(() => driver.moveNext());
			}
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="systemPrompt"]', popover: {
			title: '关于系统提示词', description: '我们提供了一种类似Skills的元数据语法<br/>' +
					'可以控制模型使用的工具<br/>' +
					'<pre>' +
					'---\n' +
					'disabled-tools: *\n' +
					'allowed-tools: tool_name\n' +
					'---\n' +
					'</pre>' +
					'如果你通过元数据强制指定工具，那么【工具调用】按钮将不会生效<br/>' +
					'系统提示词本身可以随时修改，但这些元数据只会在新对话时注入'
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="reasoning"]', popover: {
			title: '指定思考预算', description: '这是OpenAI规范 (需要我的分支让 llama.cpp 支持它)<br/>' +
					'亦可自定义请求体<br/>' +
					'手动：通过你编写的思维链(CoT)提示词进行思考，需要让模型生成&lt;think&gt;或&lt;thought&gt;标签<br/>' +
					'最低：1024 tokens<br/>' +
					'低：20% 的 max_tokens<br/>' +
					'中：50% 的 max_tokens<br/>' +
					'高：80% 的 max_tokens',
				onNextClick(element, step, {driver}) {
					switchTab("sampling").then(() => driver.moveNext());
				}
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="antiSlop#"]', popover: {
			title: '反语法约束采样', description: '基于回滚和prefill的反语法约束采样<br/>' +
					'<b>禁止</b>模型生成符合正则表达式约束的回复<br/>' +
					'要使用此功能，后端必须支持 logprobs 和 prefill',
		} },
		{ element: '#settingDialog .filter > .filter-row[data-id="additionalBody#"]', popover: {
			title: '扩展请求体', description: '此处填写的JSON将直接被合并到最终的body中，优先级最高',

			onNextClick(element, step, {driver}) {
				switchTab("data").then(() => driver.moveNext());
			}
		} },
		{ element: '#settingDialog .filter > div:nth-child(2)', popover: {
			title: '导出数据', description: '导出选中的对话，如果没有选中的，导出所有对话，和/或配置文件<br/>' +
					'如果对话中包含多媒体文件，以zip格式保存，否则json',
		} },
		{ element: '#settingDialog .filter > div:nth-child(3)', popover: {
			title: '保存预设', description: '将当前页面的设置保存为一个预设，可以在下拉框中选择或删除',
		} },
		{ element: '#settingDialog .pretty-select', popover: {
			title: '预设选择面板', description: '点击打开下拉框选择或删除预设。',

			onNextClick(element, step, {driver}) {
				jsHide(setting);
				driver.moveNext();
			}
		} },
		{
			element: '.logo > span:nth-child(1)',
			popover: {
				title: '✅ 准备就绪',
				description: '你现在真的可以开始聊天了！<br/>' +
					'在<a href="https://github.com/Roj234/ai-chat">项目README</a>中了解更多'
			}
		},
	]
});

const setting = document.querySelector("#settingDialog");
let timeout = 0;
if (setting.style.display === 'none') {
	jsHide(setting);
	timeout = 300;
}

function switchTab(tab) {
	document.querySelector(`#settingDialog .sidebar-list [data-tab=${JSON.stringify(tab)}]`).click();
	return new Promise(resolve => queueMicrotask(resolve));
}

switchTab("model").then(() => {
	const filter = document.querySelector("#settingDialog .filter");
	const child = Array.from(document.querySelectorAll("#settingDialog .filter > *"));
	child.length = 3;
	const brain = <div id={"brain"}>{child}</div>;
	filter.prepend(brain);

	setTimeout(() => {
		mainPageDriver.drive();
	}, timeout);
})