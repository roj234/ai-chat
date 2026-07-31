import {driver} from "driver.js";
import "driver.js/dist/driver.css";
import {jsHide} from "./utils/utils.js";

const removeBrainDiv = driver => {
	jsHide(setting);
	driver.moveNext();
};

const buttons = ["next", "close"];

const mainPageDriver = driver({
	showProgress: true,
	progressText: "{{current}} / {{total}}",
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
	},

	steps: [
		{ element: '#brain', popover: {
			title: '欢迎使用AiChat', description: '<b>连接脑子</b><br/>填写您的API地址、密钥和模型ID<br/>输入框支持自动补全',

				onNextClick(element, step, {driver}) {
					requestAnimationFrame(() => driver.moveNext());
				}
		} },
		{ element: '#settingDialog .filter > div:nth-child(2) button.primary', popover: {
				title: '自动探测模型能力', description: '如果连接成功，可以点击【测试能力】，这会消耗几百Token检测模型的各项能力，省去手动配置。',

				onNextClick(element, step, {driver}) {
					switchTab("general").then(() => driver.moveNext());
				}
		} },

		{ element: '#settingDialog .filter > div:nth-child(1)', popover: {
			title: '导入数据', description: '导入之前导出的数据，或插件支持的格式<br/>' +
					'例如BasicRoleplay插件可以导入酒馆的V2/V3角色卡(json/png)',

		} },
		{ element: '#settingDialog .filter > div:nth-child(2) button', popover: {
			title: '保存预设', description: '创建一个预设<br/>预设指 模型 采样参数 系统提示词 的组合<br/>使用下划线开头创建隐藏预设<br/>预设可以按名称引用',
		} },
		{ element: '#settingDialog .pretty-select', popover: {
			title: '预设选择面板', description: `添加的预设可以在这里管理。<br/><br/>现在可以开始聊天了！<br/><b>想要变强吗？</b><br/>查看文档获取更多信息！`,
		} },
	]
});

const setting = document.querySelector("#settingDialog");
let timeout = 0;
if (setting.style.display === 'none') {
	jsHide(setting);
	timeout = 300;
}

const switchTab = tab => {
	document.querySelector(`#settingDialog .sidebar-list [data-tab=${JSON.stringify(tab)}]`).click();
	return new Promise(resolve => queueMicrotask(resolve));
};

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