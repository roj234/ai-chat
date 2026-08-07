import {$state, $update, $watch, unconscious} from "unconscious";
import {inputText} from "/src/states.js";
import {getToolParameters} from "/src/toolset.js";
import {markMessageDirty} from "/src/database.js";

const USER_PREFIX = "User choice:\n";

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
export const AskUser = {
	name: "AskUser",
	description: "Ask the user to choose from suggested options or provide a custom answer."
		+" Use when the next step requires user decision, clarification, or interactive branching."
		+" Call this tool in parallel to ask multiple questions."
	,
	parameters: {
		type: "object",
		properties: {
			question: { type: "string", description: "Short question shown to the user.", },
			options: {
				type: "array",
				description: "Suggest choices that user can pick from.",
				minItems: 1,
				maxItems: 6,
				items: {
					type: "string",
					description: "A concise label or explanation."
				}
			},
			placeholder: { type: "string", default: 'Input your choice' },
			multiple: { type: "boolean", default: false }
		},
		required: ["question", "options"]
	},

	interactive: true,
	title(tc, ctx) {
		const par = getToolParameters(ctx, tc);
		return <div className={'rp-choice-label'}>✦ {par.question}</div>;
	},
	script({options}) {
		return options[0];
	},
	keyFunc(keys, response, frozen) {
		keys.push(response.content, frozen);
	},
	renderer(response, frozen, tc, message) {
		const content = $state(response.content?.slice(response.content.startsWith(USER_PREFIX) ? USER_PREFIX.length : 0));
		if (frozen) {
			return <div className={"rp-choice"}>
				<button className="selected" style={"white-space:pre-line"} title={"已选择"} disabled dangerouslySetInnerHTML={content}></button>
			</div>;
		}

		$watch(content, () => {
			const value = unconscious(content).trim();
			response.success = !!value;
			response.content = value ? USER_PREFIX + value : '';
			markMessageDirty(message);
			$update(inputText);
		}, false);
		let ta;

		const arg = getToolParameters(response, tc);
		let isSelected, toggle;
		if (arg.multiple) {
			const selection = $state([]);
			$watch(content, () => {
				const value = unconscious(content) || '';
				selection.value = value.trimStart().split('\n');
			});
			$watch(selection, () => {
				content.value = selection.join('\n');
			}, false);

			isSelected = opt => unconscious(selection).includes(opt);
			toggle = opt => {
				const x = selection.indexOf(opt);
				if (x >= 0) selection.splice(x, 1);
				else selection.push(opt);
			}
		} else {
			isSelected = opt => unconscious(content) === opt;
			toggle = opt => content.value = opt;
		}

		return <div className={"rp-choice"}>
			{arg.options.map((opt, i) => (
				<button
					class:selected={() => isSelected(opt)}
					onClick={() => toggle(opt)}
				>
					<span dangerouslySetInnerHTML={opt}/>
				</button>
			))}

			<div className="input">
				<textarea
					placeholder={arg.customAnswerLabel || "召唤邪神"}
					ref={ta}
					rows="8"
					onInput={() => content.value = ta.value}
					value={content}
				/>
			</div>
		</div>;
	}
};

