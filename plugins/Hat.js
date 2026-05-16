//Human as tool

import {registerTools} from "../src/skills.js";

/**
 *
 * @type {AiChat.FunctionTool}
 */
const find_import = {
	name: "find_import",
	description: "Find code reference",

	parameters: {
		type: "object",
		properties: {
			file: {
				type: "string"
			}
		},
		required: ["file"],
		additionalProperties: false,
	},

	interactive: true,
	script({file}, ctx) {
		ctx.file = file;
	},
	renderer(ctx) {
		return <div>
			我懒得写了，反正大概可以抄ask_user的代码
		</div>
	}
}

registerTools("hat", "", [find_import], {
	hidden: "manual"
})