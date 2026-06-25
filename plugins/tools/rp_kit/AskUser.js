import {$state, $update, $watch, unconscious} from "unconscious";
import {inputText} from "/src/states.js";
import {getToolParameters} from "/src/skills.js";

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
export const AskUser = {
	name: "AskUser",
	description: "Ask the user to choose from suggested options or provide a custom answer."
		+" Use when the next step requires user decision, clarification, or interactive branching."
		+" You may call this tool multiple times at once."
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
			}
		},
		required: ["question", "options"]
	},

	interactive: true, // 要求用户必须做出选择
	script({options}) {
		return options[0];
	},
	keyFunc(keys, response, frozen) {
		keys.push(response.content, frozen);
	},
	renderer(response, frozen, tc) {
		let content = $state(response.content);
		$watch(content, () => {
			const value = unconscious(content);
			response.success = !!value;
			response.content = value;
			$update(inputText);
		}, false);
		let ta;

		const data = getToolParameters(response, tc);
		return <div className={"rp-choice"}>
			<div className="label">✦ {data.question}</div>
			{frozen ?
				<div className="choices">
					<button className="selected" title={"已选择"} disabled>
						<span dangerouslySetInnerHTML={content}/>
					</button>
				</div>
				: (<>
					<div className="choices">
						{data.options.map((opt, i) => (
							<button
								class:selected={() => content.value === opt}
								onClick={() => content.value = opt}
							>
								<span dangerouslySetInnerHTML={opt}/>
							</button>
						))}

						<div className="input">
						<textarea
							placeholder="召唤邪神"
							ref={ta}
							rows="2"
							onInput={() => content.value = ta.value}
							value={content}
						/>
						</div>
					</div>

				</>)
			}
		</div>;
	}
};

