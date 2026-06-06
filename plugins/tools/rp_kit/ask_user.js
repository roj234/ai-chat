import {$state, $update, $watch} from "unconscious";
import {abortCompletion} from "/src/states.js";

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
export const ask_user = {
	name: "ask_user",
	description: "Ask the user to choose from suggested options or provide a custom answer."
		+" Use when the next step requires user decision, clarification, or interactive branching."
		+" You may call this tool multiple times at once." // parallel_tool_calls
	,
	parameters: {
		type: "object",
		properties: {
			question: { type: "string", description: "Short question shown to the user.", maxLength: 100 },
			options: {
				type: "array",
				description: "Suggested choices the user can pick from.",
				minItems: 1,
				maxItems: 6,
				items: {
					type: "string",
					description: "A concise label or explanation."
				}
			},
			custom: {
				type: "boolean",
				description: "Whether the user may type a custom answer.",
				default: true
			}
		},
		required: ["question", "options"]
	},

	interactive: true, // 要求用户必须做出选择
	script({question, options, custom = true}, response) {
		response.data = {question, options, custom};
		return options[0];
	},
	keyFunc(keys, response, frozen) {
		keys.push(response.content, frozen);
	},
	renderer(response, frozen) {
		let content = $state(response.content);
		$watch(content, () => {
			response.content = content.value;
			$update(abortCompletion);
		}, false);
		let ta;

		return <div>
			<div className="choice-label">✦ {response.data.question}</div>
			{frozen ?
				<div className="choice-list">
					<button className="choice-item selected" title={"已选择"} disabled>
						<span dangerouslySetInnerHTML={content}/>
					</button>
				</div>
				: (<>
					<div className="choice-list">
						{response.data.options.map((opt, i) => (
							<button
								className="choice-item"
								class:selected={() => content.value === opt}
								onClick={() => content.value = opt}
							>
								<span dangerouslySetInnerHTML={opt}/>
							</button>
						))}

						{response.data.custom ? <div className="choice-custom">
						<textarea
							placeholder="召唤邪神"
							ref={ta}
							rows="2"
							onInput={() => content.value = ta.value}
							value={content}
						/>
						</div> : null}
					</div>

				</>)
			}
		</div>;
	}
};

