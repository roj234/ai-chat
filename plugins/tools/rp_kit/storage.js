import {$update} from "unconscious";
import {createStateListener, getToolParameters, jsonPathOp} from "/src/skills.js";
import {parseJsonPath} from "unconscious/common/json-schema-utils.js";

const operationLabels = {
	set: '更新', add: '数值变动', push: '获得物品', merge: '属性修正', delete: '移除'
};

/**
 *
 * @type {AiChat.FunctionTool}
 * @private
 */
export const storage = {
	name: "manage_storage",
	description:
		"Store, read, and update structured session state such as inventories, HP, task progress, scores, flags, and temporary simulation data."
		+" Use this for state that must persist during the current scenario."
		+" Do not use it for long-term user memory or file contents."
	,
	parameters: {
		type: "object",
		properties: {
			// TODO 太复杂了要改，比如拆成多个工具
			operation: {
				enum: ["get", "set", "plus", "push", "merge", "delete"],
				description: `"get" reads a value; "set" overwrites; "plus" increments/decrements a number; "push" pushes an item to an array; "merge" merges an object; "delete" removes a value`
			},
			key: {pattern: "^[a-zA-Z0-9.]+$", description: `Dot-path key such as "player.hp" or "inventory.items.0"`},
			value: {
				type: "value",
				description: "Required only for set, plus, push, merge"
			}
		},
		required: ["operation", "key"]
	},

	reentrant: true,
	script({ operation, key, value }, response, global)  {
		let variables = global.variables;
		if (!variables) variables = global.variables = {};

		if (key.startsWith("\"")) key = JSON.parse(key);
		if (operation === 'merge' || operation === 'plus') {
			if (typeof value === 'string') value = JSON.parse(value);
		}

		const {value: newValue, undo} = jsonPathOp(variables, parseJsonPath(key, '.'), operation, value);

		if (operation !== "get") {
			response.undo = undo;

			const variableListener = createStateListener(global, "var_state");
			$update(variableListener);
		}

		if (operation === "set") return "updated";
		return newValue === undefined ? "undefined" : newValue;
	},
	renderer(response, has_successor, toolCall) {
		const { key, operation, value } = getToolParameters(response, toolCall);
		if (operation === 'get') return;

		return (
			<div className="var-change">
				<span className="var-key">[{key}]</span>
				<span>{operationLabels[operation]}: </span>
				<span style={{color: '#2ecc71', fontWeight: 'bold'}}>
					{operation === 'plus' && value > 0 ? `+${value}` : value}
				</span>
			</div>
		);
	},
	undo(response, global, toolCall) {
		const { key, operation } = getToolParameters(response, toolCall);

		const undo = response.undo;
		const variables = global.variables;
		if (operation === 'get' || !variables) return;

		switch (operation) {
			case 'delete':
				if (undo._isArray) {
					const paths = parseJsonPath(key);
					const index = paths.pop();
					const {value} = jsonPathOp(variables, paths, 'get');
					value.splice(index, 0, undo.value);
				}
			case 'set':
			case 'plus':
			case 'merge':
				jsonPathOp(variables, key, undo === undefined ? 'delete' : 'set', undo);
			break;
			case 'push': {
				const {value} = jsonPathOp(variables, key, 'get');
				value.length = undo;
			}
			break;
		}

		const variableListener = createStateListener(global, "var_state");
		$update(variableListener);
	}
};

if (false) {
	storage.parameters.oneOf = [
		{
			type: "object",
			properties: {
				operation: { enum: ["get", "delete"], },
				key: { $ref: "#/properties/key" },
			},
			required: ["operation", "key"]
		},
		{
			type: "object",
			properties: {
				operation: { enum: ["set", "push"], },
				key: { $ref: "#/properties/key" },
				value: { type: "value", }
			},
			required: ["operation", "key", "value"]
		},
		{
			type: "object",
			properties: {
				operation: { const: "plus", },
				key: { $ref: "#/properties/key" },
				value: { type: "number", }
			},
			required: ["operation", "key", "value"]
		},
		{
			type: "object",
			properties: {
				operation: { const: "merge", },
				key: { $ref: "#/properties/key" },
				value: { type: "object", }
			},
			required: ["operation", "key", "value"]
		},
	];
}