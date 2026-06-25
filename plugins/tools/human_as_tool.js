import {getToolParameters, registerTools} from "/src/skills.js";
import {inputText} from "/src/states.js";
import {$state, $update, $watch, unconscious} from "unconscious";
import "./rp_kit/interactive_simulation.css";

const humanAsTool = {
	renderer(response, frozen) {
		let content = $state(response.content);
		$watch(content, () => {
			const value = unconscious(content);
			response.success = !!value;
			response.content = value;
			console.log(response);
			$update(inputText);
		}, false);
		let ta;

		return <div className={"rp-choice"}>
			<div className="choices">
				<div className="input">
						<textarea
							placeholder="召唤邪神"
							ref={ta}
							rows="5"
							onInput={() => content.value = ta.value}
							disabled={frozen}
							value={content}
						/>
				</div>
			</div>
		</div>;
	},
	keyFunc(keys, response, frozen) {
		keys.push(response.content, frozen);
	}
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const FindDeclaration = {
	name: 'FindDeclaration',
	description: 'Locate declaration of a symbol. Returns file path, line number, and definition.',
	interactive: true,
	parameters: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'The file where the usage appears (used to resolve context when the same symbol name exists in multiple scopes).'
			},
			line: {
				type: 'integer',
				description: 'The line number (1-based) of the usage in filePath.'
			},
			symbol: {
				type: 'string',
				description: 'The symbol whose declaration to look up.'
			},
		},
		required: ['path', 'line', 'symbol'],
	},

	script() {return "Error: LSP not available";},
	title(req, ctx = {}) {
		const par = getToolParameters(ctx, req);
		return "查询符号 " + par.symbol;
	},
	...humanAsTool
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const RenameSymbol = {
	name: 'RenameSymbol',
	description: 'Renames a symbol throughout the codebase. All references and the declaration itself are updated.',
	interactive: true,
	parameters: {
		type: 'object',
		properties: {
			oldName: {
				type: 'string',
				description: 'The current symbol name to be replaced.'
			},
			newName: {
				type: 'string',
				description: 'The replacement name.'
			},
			path: {
				type: 'string',
				description: 'The file containing the symbol (used to pinpoint the exact declaration).'
			},
			line: {
				type: 'integer',
				description: 'Line number (1-based) of the symbol occurrence.'
			},
			character: {
				type: 'integer',
				description: 'Character offset (1-based) on the line, to disambiguate multiple symbols on the same line.'
			}
		},
		required: ['oldName', 'newName', 'path', 'line']
	},

	script() {return "Error: LSP not available";},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		return "重命名符号 "+par.oldName+" => "+par.newName;
	},
	...humanAsTool
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const EndToEndTest = {
	name: 'EndToEndTest',
	description: 'Performs an end-to-end test based on a natural-language test scenario. Reports whether the test passed or failed.',
	interactive: true,
	parameters: {
		type: 'object',
		properties: {
			scenario: {
				type: 'string',
				description: 'A detailed description of the actions to perform (e.g. "Log in as admin, create a new user, verify success message").'
			},
			criteria: {
				type: 'string',
				description: 'The expected outcome or condition that defines a pass (e.g. "A green toast with text User created").'
			}
		},
		required: ['scenario', 'criteria']
	},
	script() {return "Error: Failed to process request: Timeout";},
	...humanAsTool
};

export const registerHumanAsTool = () => {
	registerTools(
		"HumanAsTool",
		"帮LLM找定义节省token吧！",
		[FindDeclaration, RenameSymbol, EndToEndTest],
		{ hidden: 'manual' }
	);
}
