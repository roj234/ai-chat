import {$state, $update, $watch} from "unconscious";
import {abortCompletion} from "/src/states.js";

function format_output(choice) {
	return `User has answered your questions: ${choice}. You can now continue with the user's answers in mind.`
}

/**
 *
 * @type {AiChat.FunctionTool<{data: {title: string, options: string[]}}>}
 * @private
 */
export const ask_user = {
	name: "ask_user",
	description: "向用户展示问题和一组建议选项，用户也可自由输入。",
	parameters: {
		type: "object",
		properties: {
			question: { type: "string", description: "The question", maxLength: 30 },
			options: {
				type: "array",
				items: {
					type: "string",
					description: "Explanation of choice"
				}
			},
			custom: {
				type: "boolean",
				description: "Allow typing a custom answer",
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

