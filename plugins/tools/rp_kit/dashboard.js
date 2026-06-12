import {createStateListener, getToolParameters, TOOL_NAME} from "/src/skills.js";
import {$state, $update, $watch, appendChild, unconscious} from "unconscious";
import {messages, onConversationLoaded} from "/src/states.js";
import {onLoad} from "/src/plugin.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {jsonPathOp} from "unconscious/common/json-schema-utils.js";

/**
 * Dashboard 工具：管理全局浮动 UI
 * @type {AiChat.FunctionTool}
 */
export const dashboard = {
	name: "init_dashboard",
	description: "Create or update a floating visual dashboard."
		+ " Use to display persistent structured state such as HP, inventory, progress, environment, scores, or mission status."
		//+ " Dashboard fields should reference storage variables so they update automatically."
		+ " Do not use for one-off text, simple summaries, or state that will not be updated."
	,
	parameters: {
		type: "object",
		properties: {
			html: {
				type: "string",
				description:
					"Dashboard HTML/template. It should reference values stored by manage_storage, such as "
					+ "`HP: <b>{{player.hp}}</b> / <b>{{player.max_hp}}</b>`. "
					+ "Initialize or update the relevant storage keys first when needed. "
					+ "Do not include scripts, event handlers, iframes, or external resources.",
			}
		},
		required: ["html"]
	},

	reentrant: true,
	script({html}, self, global) {
		global.dashboard = html;

		const dashboard_listener = createStateListener(global, "dashboard");
		$update(dashboard_listener);

		return "done";
	},
	undo(ctx, global) {
		const dashboard_listener = createStateListener(global, "dashboard");
		$update(dashboard_listener);

		const msgs = unconscious(messages);
		for (let i = msgs.length - 1; i >= 0; i--) {
			let {tool_calls, tool_responses} = msgs[i];
			if (tool_responses) {
				for (let j = tool_responses.length - 1; j >= 0; j--) {
					let response = tool_responses[j];
					if (response[TOOL_NAME] === "init_dashboard") {
						global.dashboard = getToolParameters(response, tool_calls[j]).html;
						return;
					}
				}
			}
		}
		global.dashboard = null;
	}
};

const dashboardState = $state();
onLoad((app) => appendChild(app, dashboardState));

onConversationLoaded((conv, messages) => {
	const dashboard_listener = createStateListener(conv, "dashboard");

	let listeners = [];
	const runListeners = () => {
		for (const [element, path] of listeners) {
			element.textContent = jsonPathOp(conv.variables, path, "get").value ?? path;
		}
	};

	let var_listener;

	$watch(dashboard_listener, () => {
		listeners.length = 0;

		const html = conv.dashboard;
		if (!html) {
			dashboardState.value = null;
		} else {
			if (!var_listener) {
				var_listener = createStateListener(conv, "var_state");
				$watch(var_listener, runListeners, false);
			}

			const node = <div className={`rp-dashboard`} />;
			renderMarkdownToElement(node, html.replace(/\{\{(.+?)}}/g, (match, path) => {
				return '`'+path+'`';
			}), {
				noHighlight: true,
				noImage: true
			});

			node.querySelectorAll("kbd").forEach(item => {
				const span = <span />;
				listeners.push([
					span,
					item.textContent
				]);
				item.replaceWith(span);
			});
			runListeners();
			dashboardState.value = node;
		}
	});
});