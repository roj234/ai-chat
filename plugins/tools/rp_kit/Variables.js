import {getToolParameters, jsonEval, updateConversationState} from "/src/skills.js";
import {jsonGet, parseJsonPointer} from "unconscious/common/json-schema-utils.js";
import {showToast} from "/src/components/Toast.js";
import {prettyError} from "/src/utils/utils.js";

const operationLabels = { set: '更新', plus: '增加', delete: '移除' };

/**
 *
 * @type {AiChat.FunctionTool}
 */
export const UpdateVariable = {
	name: "UpdateVariable",
	description: `Update structured state such as inventories, HP, task progress, scores, flags, and temporary simulation data.
Use this for state that must persist during current conversation.
This is NOT cross-conversation memory.

Variable naming: camelCase

Operation semantics:

- set     Overwrite: accepts any type. Missing intermediate objects are auto-created.
          Use \`/-\` as the final segment to append to an array (eg: \`/inventory/items/-\`).
- plus    Numeric delta: target must be a number; \`value\` is added as an increment (negative = decrement). If the path does not exist, baseline is 0.
- delete  Remove target: omit \`value\`. 
          Array element target will be spliced: delete "/inventory/items/1" -> splice index 1

Return value: the new value at the pointer after the operation completes.`
	,
	parameters: {
		type: "object",
		properties: {
			// maybe a MOVE(from, to)
			operation: { enum: ["set", "plus", "delete"], },
			pointer: {pattern: "^/[a-zA-Z0-9/]+-?$", description: `JSON Pointer like "/player/hp" or "/inventory/items/0"; `},
			explanation: {
				type: "string",
				description: "One sentence human-readable summary of why change it."
			},
			value: { type: "value", description: "Omit for delete" },
		},
		required: ["operation", "pointer"]
	},

	reentrant: true,
	script({ operation, pointer, value }, response, conv)  {
		let variables = conv.variables;
		if (!variables) variables = conv.variables = {};

		if (operation === 'plus') {
			if (typeof value === 'string') value = JSON.parse(value);
			if (typeof value !== 'number') throw "value must be a number";
		} else if (operation === 'delete') {
			if (value !== undefined)
				throw "value must be omitted for delete operations";
		} else if (value === undefined) {
			throw `value is required for ${operation} operations`;
		}

		const {value: newValue, undo} = jsonEval(variables, parseJsonPointer(pointer), operation, value);

		response.undo = undo;
		updateConversationState(conv, "IS:variables");

		if (operation === "set") {
			if (pointer.endsWith("/-")) {
				return "append to array["+(newValue.length-1)+"]";
			}
			return "updated";
		}
		if (operation === "delete") {
			return newValue ? "deleted" : "not deleted";
		}
		return newValue === undefined ? "undefined" : newValue;
	},
	undo(response, conv, toolCall) {
		const variables = conv.variables;
		if (!variables || !('undo' in response)) return;

		const { pointer, operation } = getToolParameters(response, toolCall);
		const path = parseJsonPointer(pointer);
		const undo = response.undo;

		try {
			// noinspection FallThroughInSwitchStatementJS
			switch (operation) {
				case 'delete':
					if (undo._isArray) {
						const index = path.pop();
						jsonGet(variables, path).splice(index, 0, ...undo.value);
						break;
					}
				case 'set':
					if (operation === 'set' && path.at(-1) === '-') {
						jsonGet(variables, path).length = undo;
						break;
					}
				case 'plus':
					jsonEval(variables, path, undo === undefined ? 'delete' : 'set', undo);
					break;
			}
		} catch (e) {
			showToast("Failed to undo\n"+prettyError(e), 'error');
			return;
		}

		updateConversationState(conv, "IS:variables");
	},
	title(tc, ctx = {}) {
		const { pointer, operation, value } = getToolParameters(ctx, tc);

		return (
			<span>[{parseJsonPointer(pointer).join('.')}] {operationLabels[operation]}: <b style={{
				color: '#2ecc71'
			}}>{operation === 'plus' && value > 0 ? `+${value}` : JSON.stringify(value)?.slice(0, 50)}</b></span>
		);
	},
};

/**
 *
 * @type {AiChat.FunctionTool<{ pointer: string }>}
 */
export const GetVariable = {
	name: "GetVariable",
	parameters: {
		type: "object",
		properties: {
			pointer: {pattern: "^/[a-zA-Z0-9/]+$" }
		},
		required: ["pointer"]
	},

	reentrant: true,
	script({ pointer }, response, conv)  {
		const value = jsonGet(conv.variables, pointer);
		return value === undefined ? "undefined" : value;
	},
	title(tc, ctx = {}) { return "读取变量 "+getToolParameters(ctx, tc).pointer; }
};
