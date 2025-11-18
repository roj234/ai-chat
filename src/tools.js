import {safeEval} from "./SafeEval.js";
import {ChartCreator} from "./Chart.js";
import {messages, selectedConversation} from "./states.js";
import {$watch} from "unconscious";

/**
 *
 * @type {OpenAI.Tool}
 * @private
 */
const _runJavaScript = {
	"type": "function",
	"function": {
		"name": "runJavaScript",
		"description": "Run a javascript function in sandbox. Useful for computations or simple scripts.",
		"parameters": {
			"type": "object",
			"properties": {
				"code": { "type": "string" },
				"timeout": {
					"type": "number",
					"default": 1000,
					"description": "timeout milliseconds."
				},
			},
			"required": ["code"]
		}
	}
};
/**
 *
 * @type {OpenAI.Tool}
 * @private
 */
const _chart = {
	"type": "function",
	"function": {
		"name": "chart",
		"description": "Create a Chart.js chart. The chart can be embedded in Markdown responses using ```chart\nchartId``` syntax.",
		"parameters": {
			"type": "object",
			"properties": {
				"chartId": { "type": "string", "example": "myChart_1" },

				"type": {
					"type": "string",
					"enum": ["line", "bar", "radar", "polarArea", "pie", "doughnut", "scatter"]
				},

				"data": {
					"type": "object",
					"description": "Chart data structure.",
					"properties": {
						"labels": {
							"type": "array",
							"description": "Array of labels for the X-axis (or categories).",
							"items": {
								"type": "string"
							}
						},
						"datasets": {
							"type": "array",
							"items": {
								"type": "object",
								"properties": {
									"label": { "type": "string" },
									"data": {
										"type": "array",
										"items": { "type": "number" }
									}
								},
								"required": ["label", "data"]
							}
						}
					},
					"required": ["labels", "datasets"]
				},

				"options": {
					"type": "object",
					"description": "Additional Chart.js options (e.g., scales, plugins).",
					"example": { "responsive": true }
				},

				"colors": {
					"type": "array",
					"description": "Override color palette for datasets in #RRGGBB format.",
					"items": { "type": "string" },
					"example": ["#FF6384", "#36A2EB"]
				}
			},
			"required": ["chartId", "type", "data"]
		}
	}
};

export const tools = [
	_runJavaScript,
	_chart
];

const toolPersist = new Set(["chart"]);

$watch(selectedConversation, () => {
	if (selectedConversation.ready) {
		for (const m of messages.value) {
			if (m.tool_calls) {
				for (const call of m.tool_calls) {
					if (toolPersist.has(call.function.name)) {
						try {
							toolImpl[call.function.name](call.function.arguments ? JSON.parse(call.function.arguments) : null);
						} catch {}
					}
				}
			}
		}
	} else {
		ChartCreator.destroyAllCharts();
	}
});

/**
 *
 * @type {Record<string, function(Object): any | Promise<any>>}
 */
export const toolImpl = {
	runJavaScript(data) {
		return safeEval(data.code, data.timeout);
	},
	chart(data) {
		ChartCreator.createChart(data);
	}
};