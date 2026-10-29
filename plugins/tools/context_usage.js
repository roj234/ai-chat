import {registerToolset} from "/src/toolset.js";
import {getCombinedPreset} from "/src/presets.js";

/**
 * @type {AiChat.FunctionTool}
 */
const ContextUsage = {
	name: "ContextUsage",
	description: `Read context usage`,
	async script(par, response, conv) {
		return `${conv.contextUsage} / ${(await getCombinedPreset(conv)).maxContext}`;
	},
	title: (req, ctx) => {return "当前上下文 "+ctx.content;}
}

registerToolset(
	"ContextUsage",
	"让模型查已用上下文.",
	[ContextUsage],
	{
		//default: true,
		hidden: "manual"
	}
);