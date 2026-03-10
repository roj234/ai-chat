import {jsonPathOp, volatileEnvironment} from "../../skills.js";
import {$computed, $disposable, $state, $watch, debugSymbol} from "unconscious";
import morphdom from "morphdom";
import {messages} from "../../states.js";
import {onWindowLoad} from "../../utils.js";

const HTML = debugSymbol("UNPERSISTED_DATA");

/**
 * Dashboard 工具：管理全局浮动 UI
 * @type {AiChat.FunctionTool}
 */
export const dashboard = {
	name: "init_dashboard",
	description: "设置浮动状态看板的结构。用于显示关键状态（如属性、环境、任务进度）。",
	parameters: {
		type: "object",
		properties: {
			html: {
				type: "string",
				description: "看板内容。必须读取`manage_storage`工具保存的数据，例如: 'HP: <b style=\"color:red; width: calc(100% * {{player.hp}} / {{player.max_hp}})\">{{player.hp}}</b>'; 数据会自动更新"
			}
		},
		required: ["html"]
	},

	autorun: true,
	script({html}, self) {
		volatileEnvironment.dashboard = html;
		self[HTML] = html;
	},
	removed() {
		for (let i = messages.length - 1; i >= 0; i--) {
			let {tool_responses} = messages.value[i];
			if (tool_responses) {
				for (let j = tool_responses.length - 1; j >= 0; j--) {
					let response = tool_responses[j];
					if (response.tool_name === "init_dashboard") {
						volatileEnvironment.dashboard = response[HTML];
						return;
					}
				}
			}
		}
		volatileEnvironment.dashboard = null;
	}
};

// 简单的变量替换引擎
function parseTemplate(template, state) {
	return template.replace(/\{\{(.+?)}}/g, (match, path) => {
		return jsonPathOp(state, path, "get").value ?? match;
	});
}

// Dashboard 浮动组件
const DashboardComponent = () => {
	const html = volatileEnvironment.dashboard;
	if (!html) return null;

	const base = <div></div>;

	let globalState = volatileEnvironment.rp_state;
	if (!globalState) globalState = volatileEnvironment.rp_state = $state({});

	const callback = () => {
		morphdom(base, <div dangerouslySetInnerHTML={parseTemplate(html, globalState)}/>);
	};
	$watch(globalState, callback);
	$disposable(base, [globalState, callback])
	return base;
};

// Dashboard
onWindowLoad(() => {
	document.body.append(<div className={`rp-dashboard`}>{$computed(DashboardComponent, [volatileEnvironment])}</div>);
})