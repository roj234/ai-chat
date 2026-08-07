import {getToolParameters, registerToolset} from "/src/toolset.js";
import {inputText} from "/src/states.js";
import {$state, $update, $watch, unconscious} from "unconscious";
import "./rp_kit/interactive_simulation.css";
import {markMessageDirty} from "/src/database.js";

/**
 * @type {AiChat.FunctionTool<*>}
 */
const HumanInput = {
	name: 'HumanInput',
	description: 'Performs an operation based on natural-language prompts (such as UI testing).',
	interactive: true,
	parameters: {
		type: 'object',
		properties: {
			task: {
				type: 'string',
				description: 'A detailed description of the actions to perform (e.g. "Log in as admin, create a new user, verify success message").'
			},
			expected: {
				type: 'string',
				description: 'The expected outcome or condition that defines a pass (e.g. "A green toast with text User created").'
			}
		},
		required: ['task', 'expected']
	},
	title(tc, ctx) {
		const par = getToolParameters(ctx, tc);
		return <div className={'rp-choice-label'}>请操作: {par.task}</div>;
	},
	script() {},
	renderer(response, frozen, tc, message) {
		let content = $state(response.content);
		$watch(content, () => {
			const value = unconscious(content);
			response.success = !!value;
			response.content = value;
			markMessageDirty(message);
			$update(inputText);
		}, false);
		let ta;

		const data = getToolParameters(response, tc);
		return <div className={"rp-choice"}>
			<div className="input">
				<textarea
					placeholder={data.expected}
					ref={ta}
					rows="8"
					onInput={() => content.value = ta.value}
					disabled={frozen}
					value={content}
				/>
			</div>
		</div>;
	},
	keyFunc(keys, response, frozen) {
		keys.push(response.content, frozen);
	}
};

registerToolset(
	"HumanInput",
	"兄弟，我发现用脑子思考不需要花 token！",
	[HumanInput],
	{
		default: true,
		hidden: 'manual'
	}
);
