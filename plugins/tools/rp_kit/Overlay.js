import {getToolParameters, TOOL_NAME, updateConversationState, watchConversationState} from "/src/skills.js";
import {$state, appendChild, unconscious} from "unconscious";
import {messages, onConversationLoaded} from "/src/states.js";
import {onLoad} from "/src/plugin.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {jsonGet} from "unconscious/common/json-schema-utils.js";

/**
 * @type {AiChat.FunctionTool<{
 *     html: string
 * }>}
 */
export const ConfigureOverlay = {
	name: "ConfigureOverlay",
	description: "Create or update a floating visual overlay."
		+ " Use to display persistent structured state such as HP, inventory, progress, environment, scores, or mission status."
		+ " Do not use for one-off text, simple summaries, or state that will not be updated."
	,
	parameters: {
		type: "object",
		properties: {
			html: {
				type: "string",
				description:
					"HTML template. It SHOULD reference values stored by UpdateVariable, such as "
					+ "`HP: <b>{{player.hp}}</b> / <b>{{player.max_hp}}</b>` "
					+ "so that they will be updated automatically. "
					+ "Do not include scripts, event handlers, iframes, or external resources.",
			}
		},
		required: ["html"]
	},

	reentrant: true,
	script({html}, response, conv) {
		conv.overlay = html;
		updateConversationState(conv, "IS:overlay");
		return "overlay configured";
	},
	undo(ctx, conv) {
		updateConversationState(conv, "IS:overlay");

		const msgs = unconscious(messages);
		for (let i = msgs.length - 1; i >= 0; i--) {
			let {tool_calls, tool_responses} = msgs[i];
			if (tool_responses) {
				for (let j = tool_responses.length - 1; j >= 0; j--) {
					let response = tool_responses[j];
					if (response[TOOL_NAME] === ConfigureOverlay.name) {
						conv.overlay = getToolParameters(response, tool_calls[j]).html;
						return;
					}
				}
			}
		}
		conv.overlay = null;
	}
};

const overlayState = $state();
onLoad((app) => appendChild(app, overlayState));

onConversationLoaded((conv, messages) => {
	let listeners = [];
	const runListeners = () => {
		for (const [element, path] of listeners) {
			element.textContent = jsonGet(conv.variables, path) ?? path;
		}
	};

	let var_listener;

	watchConversationState(conv, "IS:overlay", () => {
		listeners.length = 0;

		const html = conv.overlay;
		if (!html) {
			overlayState.value = null;
		} else {
			if (!var_listener) {
				watchConversationState(conv, "IS:variables", runListeners, false);
				var_listener = 1;
			}

			const node = <div className={`rp-overlay`} />;
			renderMarkdownToElement(node, html.replace(/\{\{(.+?)}}/g, (match, path) => {
				return '`'+path+'`';
			}), {
				noHighlight: true,
				noImage: true
			});
			if (node.childNodes.length === 1 && node.childNodes[0].nodeName === 'P')
				node.replaceChildren(...node.childNodes[0].childNodes);

			node.querySelectorAll("kbd").forEach(item => {
				const span = <span />;
				listeners.push([
					span,
					item.textContent.split(".")
				]);
				item.replaceWith(span);
			});
			runListeners();
			overlayState.value = node;
		}
	});
});