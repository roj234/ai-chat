/**
 * 新手引导（driver.js）
 *
 * 只在「没有配置 + 没有任何对话」时由 main.js 动态 import，走一遍「能聊天的
 * 最小配置」路径：输入框 → 设置中心 → 模型（供应商 / 模型 两级）→ 提示词 → 数据。
 *
 * 设置界面的 DOM 结构见 components/SettingDialog.jsx（窗口由 Windows.jsx 生成）：
 *
 *   .win-body.settings
 *     .ntp
 *       .col > .sidebar-list > ._vl > .chat-item[data-tab=general|provider|prompt|...]
 *       .filter                     // 普通分页：.filter-row[data-id=xxx]
 *       .filter.sd-provider         // 模型分页：.col-detail（供应商下拉 + 保存 + 子标签）+ .tab-content
 *         .col-detail .pretty-select
 *         .tab-content > .filter-row[data-id=endpoint|accessToken|model|...]
 *
 * 所以引导里切换分页 / 切换「编辑供应商↔编辑模型」都是通过点击这些节点完成的，
 * 不直接依赖 SettingDialog 的内部变量。
 */
import {driver} from "driver.js";
import "driver.js/dist/driver.css";
import {DI_settings} from "./hooks.js";

const SETTINGS_BODY = ".win-body.settings";
const SETTINGS_FALLBACK_BUTTON = ".sidebar .ri-wrench-line";

const $ = selector => document.querySelector(selector);
const settingsRoot = () => $(SETTINGS_BODY);
/** 设置窗口本体（.win-body 的兄弟 .win-header 在这里面） */
const settingsWindow = () => settingsRoot()?.closest(".window");

const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 取设置窗口里某个字段所在的行（Filter 会给每行打 data-id）
 * @param {string} id
 * @return {() => HTMLElement | null}
 */
const settingRow = id => () => settingsRoot()?.querySelector(`.filter-row[data-id="${id}"]`);

/**
 * 打开设置窗口。DI_settings 由 hooks.injectCommonDI 注入，正常情况下一定有；
 * 万一是插件环境没注入，就退回点击侧边栏的齿轮按钮。
 */
const openSettings = async () => {
	if (!settingsRoot()) {
		if (DI_settings?.show) DI_settings.show();
		else $(SETTINGS_FALLBACK_BUTTON)?.click();

		await frame();
		await frame();
	}
	return !!settingsRoot();
};

/**
 * 切换到设置窗口的某个分页
 * @param {string} tab
 */
const showTab = async tab => {
	const item = settingsRoot()?.querySelector(`.sidebar-list [data-tab="${tab}"]`);
	if (!item) return false;

	if (!item.classList.contains("active")) item.click();
	await frame();
	await sleep(30);
	return true;
};

/**
 * 在「模型」分页里切换左侧下拉的选中项
 * @param {'provider' | 'model'} kind provider = 编辑供应商，model = 编辑模型
 */
const showProviderView = async kind => {
	await showTab("provider");

	const select = settingsRoot()?.querySelector(".sd-provider .col-detail .pretty-select");
	if (!select) return false;

	if (!select.classList.contains("open")) select.querySelector(".input")?.click();
	// 列表是虚拟列表，展开后要等它测量完高度才会渲染出 li
	await frame();
	await frame();

	const item = select.querySelector(kind === "model" ? ".dropdown li.model" : ".dropdown li.provider");
	select.classList.remove("open");
	if (!item) return false;

	item.click();
	await frame();
	await sleep(50);
	return true;
};

/**
 * driver.js v1 在过渡动画（400ms）期间会忽略 moveNext，而我们的钩子又要先切换界面
 * 再前进，所以这里轮询直到真的移动。
 * @param {import("driver.js").Driver} driver
 * @param {(driver: import("driver.js").Driver) => void} action
 */
let navigating = false;
const move = async (driver, action) => {
	if (navigating) return;
	navigating = true;
	try {
		const from = driver.getActiveIndex();
		for (let i = 0; i < 50; i++) {
			action(driver);
			await sleep(40);
			if (!driver.isActive() || driver.getActiveIndex() !== from) return;
		}
	} finally {
		navigating = false;
	}
};
const goNext = driver => move(driver, d => d.moveNext());
const goPrev = driver => move(driver, d => d.movePrevious());

/** 等首屏 loading 遮罩消失（它会把 popover 一起盖住） */
const waitForAppReady = async () => {
	for (let i = 0; i < 60 && $("#loading"); i++) await sleep(50);
	await frame();
};

const steps = [
	{
		element: () => $(".composer .query"),
		popover: {
			title: "欢迎使用 Aint",
			description: "在这里和 AI 对话：输入框支持 <code>/</code> 指令、模型 ID 自动补全和文件拖拽。<br/>"
				+ "不过得先接上模型，跟我走一遍吧。",
			nextBtnText: "开始配置 →",
			async onNextClick(element, step, {driver}) {
				await openSettings();
				await showTab("provider");
				await goNext(driver);
			},
		},
	},
	{
		element: () => settingsRoot()?.querySelector('.sidebar-list [data-tab="provider"]'),
		popover: {
			title: "设置中心",
			description: "左侧是分区：<b>通用 / 模型 / 提示词 / 个性化 / 数据 / 工具</b>，插件也可以追加自己的分区。<br/>"
				+ "所有配置都在这一个窗口里。",
			async onNextClick(element, step, {driver}) {
				// 先保证停在「编辑模型」视图，下一步要指它的下拉栏
				await showProviderView("model");
				await goNext(driver);
			},
		},
	},
	{
		element: () => settingsRoot()?.querySelector(".sd-provider .col-detail .row"),
		popover: {
			title: "供应商 → 模型",
			description: "配置是两级的：<br/>"
				+ "• <b>编辑供应商</b>：API 地址、密钥，一份供应商配置可被多个模型复用<br/>"
				+ "• <b>编辑模型</b>：模型 ID 和采样参数<br/>"
				+ "填完点右侧 <b>保存</b> 就会存成预设，之后能按名字引用。",
			nextBtnText: "先填密钥 →",
			async onNextClick(element, step, {driver}) {
				await showProviderView("provider");
				await goNext(driver);
			},
		},
		waitForElement: 1000,
	},
	{
		element: settingRow("endpoint"),
		popover: {
			title: "API 地址",
			description: "OpenAI 兼容的接口地址，例如 <code>https://api.openai.com/v1</code>。<br/>"
				+ "中转站填它给的地址即可。",
		},
		waitForElement: 1000,
	},
	{
		element: settingRow("accessToken"),
		popover: {
			title: "API 密钥",
			description: "只保存在你自己的数据库里，不会上传。<br/>"
				+ "「用户标识」「对话标识字段」这些一般留空就能用。",
			nextBtnText: "接着填模型 →",
			async onNextClick(element, step, {driver}) {
				await showProviderView("model");
				await goNext(driver);
			},
			async onPrevClick(element, step, {driver}) {
				await showProviderView("provider");
				await goPrev(driver);
			},
		},
		waitForElement: 1000,
	},
	{
		element: settingRow("model"),
		popover: {
			title: "模型 ID",
			description: "手填或者点下拉从供应商的模型列表里补全。<br/>"
				+ "上方 <b>基础参数 / 采样参数 / 高级配置</b> 切换不同类别，不确定就只填 ID。",
			async onPrevClick(element, step, {driver}) {
				await showProviderView("provider");
				await goPrev(driver);
			},
		},
		waitForElement: 1000,
	},
	{
		element: () => settingsRoot()?.querySelector('.sidebar-list [data-tab="prompt"]'),
		popover: {
			title: "提示词",
			description: "系统提示词、标题提示词都在这。<br/>"
				+ "「选择……」下拉里有内置模板，也可以把当前提示词另存为预设。",
			async onNextClick(element, step, {driver}) {
				await showTab("prompt");
				await goNext(driver);
			},
			async onPrevClick(element, step, {driver}) {
				await showProviderView("model");
				await goPrev(driver);
			},
		},
	},
	{
		element: settingRow("systemPrompt"),
		popover: {
			title: "系统提示词",
			description: "支持 <code>{{model}}</code>、<code>{{date}}</code> 之类的占位符，以及注入 AGENTS.md。<br/>"
				+ "留空则使用内置默认提示词。",
			async onPrevClick(element, step, {driver}) {
				await showTab("prompt");
				await goPrev(driver);
			},
		},
		waitForElement: 1000,
	},
	{
		element: () => settingsRoot()?.querySelector('.sidebar-list [data-tab="data"]'),
		popover: {
			title: "数据",
			description: "导入旧备份、角色卡（需 rp_basic 插件）；连接后端数据库也在这里。<br/>"
				+ "建议偶尔用「导出」备份一下数据。",
			async onNextClick(element, step, {driver}) {
				await showTab("data");
				await goNext(driver);
			},
			async onPrevClick(element, step, {driver}) {
				await showTab("prompt");
				await goPrev(driver);
			},
		},
	},
	{
		element: () => DI_settings?.byId?.("import"),
		popover: {
			title: "导入 / 导出",
			description: "支持 zip / json / jsonl，以及酒馆 V2/V3 角色卡的 png / jpg。",
			async onPrevClick(element, step, {driver}) {
				await showTab("data");
				await goPrev(driver);
			},
		},
		waitForElement: 1000,
	},
	{
		element: () => settingsWindow()?.querySelector(".win-header"),
		popover: {
			title: "配置完成",
			description: "点右上角 ✕ 关闭设置，回到输入框就能开始聊天了。<br/>"
				+ "<b>想变强？</b>侧边栏底部可以打开文档和统计。",
			doneBtnText: "开始使用",
		},
	},
];

const tour = driver({
	showProgress: true,
	progressText: "{{current}} / {{total}}",
	nextBtnText: "继续 →",
	prevBtnText: "← 返回",
	doneBtnText: "完成",
	closeBtnLabel: "跳过引导",
	showButtons: ["next", "previous", "close"],
	// 引导期间让用户直接点按钮而不是被 overlay 关掉
	overlayClickBehavior: "none",
	// 方向键会绕过 onNextClick 里的页面切换逻辑，关掉
	allowKeyboardControl: false,
	skipMissingElement: true,
	stagePadding: 8,
	stageRadius: 8,
	steps,
});

export const startOnboarding = async () => {
	await waitForAppReady();
	tour.drive();
};

startOnboarding().catch(err => {
	// 引导失败不应该影响正常使用
	console.warn("新手引导加载失败", err);
});
