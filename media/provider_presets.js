
export const provider_presets = {
	"https://api.deepseek.com": {
		mode: "chat",
		canPrefill: true,
		prefillPath: "prefix",
		forceThink: null,
		modalities: ["tool"],
		jsonSupport: 1,
		reasoningPath: "thinking.type,\"enabled\",\"disabled\"",
		reasoningEffortPath: "reasoning_effort",
		provider: "DeepSeek",

		models: {
			"deepseek-v4-flash": {},
			"deepseek-v4-pro": {}
		}
	},
	"https://openrouter.ai/api/v1": {
		mode: "chat",
		canPrefill: true,
		prefillPath: "",
		forceThink: null,
		//modalities: ["tool"],
		jsonSupport: 2,
		reasoningPath: "",
		reasoningEffortPath: "",
		provider: "OpenRouter",

		models: {
			// 需要填几十个，并且根据它们的modalities填写
		}
	},
	// TODO 其他提供商
}