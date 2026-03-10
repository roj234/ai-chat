// Chart.js 图表工具前端实现
import {registerTools} from "../skills.js";
import {$asyncState, $computed, $watch, debugSymbol, isReactive} from "unconscious";
import {selectedConversation} from "../states.js";
import {errorBlock, loadingBlock} from "../utils.js";

// 预定义颜色数组
const colorPalette = [
	'#FF6384', '#36A2EB', '#FFCE56',
	'#4BC0C0', '#9966FF', '#FF9F40',
	'#C9CBCF',
];

/**
 * 十六进制颜色转RGBA
 */
function hexToRgba(hex, alpha) {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 深度合并对象
 */
function deepMerge(target, source) {
	const result = { ...target };

	for (const key in source) {
		if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
			result[key] = deepMerge(target[key] || {}, source[key]);
		} else {
			result[key] = source[key];
		}
	}

	return result;
}

/**
 * 构建Chart.js配置对象
 */
function buildChartConfig({ type, data, title }) {
	const isPie = ['pie', 'doughnut', 'polarArea'].includes(type);

	let defaultOptions = {
		plugins: {
			legend: {
				position: 'bottom',
				title: {
					display: !!title,
					padding: 4,
					text: title
				}
			}
		}
	};
	if (['radar'].includes(type)) {
		defaultOptions = {
			scales: {
				r: { beginAtZero: true }
			}
		};
	}

	return {
		type,
		data: {
			labels: data.labels,
			datasets: data.datasets.map((dataset, index) => {
				const baseColor = colorPalette[index % colorPalette.length];

				return {
					...dataset,
					backgroundColor: dataset.backgroundColor || (isPie ? colorPalette : hexToRgba(baseColor, 0.2)),
					borderColor: dataset.borderColor || (isPie ? "#fff" : baseColor),
					borderWidth: dataset.borderWidth || 2,
					fill: dataset.fill !== undefined ? dataset.fill : (type !== 'line')
				};
			})
		},
		options: defaultOptions//deepMerge(defaultOptions, options)
	};
}

let Chart;

/**
 * 销毁所有图表
 */
$watch(selectedConversation, () => {
	if (!selectedConversation.ready && Chart) {
		for (const chart of Object.values(Chart.instances)) {
			chart.destroy();
		}
	}
})

const CHART = debugSymbol("CHART");
const OPTIONS = debugSymbol("OPTIONS");

registerTools("chart", "绘制图表. 当需要可视化、比例、趋势分析或任何复杂的数据展示时，调用此工具。", [{
	name: "chart",
	description: "Create a Chart.js chart",
	parameters: {
		type: "object",
		properties: {
			type: { enum: ["line", "bar", "radar", "polarArea", "pie", "doughnut", "scatter"] },

			data: {
				type: "object",
				properties: {
					labels: {
						type: "array",
						description: "Array of labels for the X-axis (or categories).",
						items: { type: "string" }
					},
					datasets: {
						type: "array",
						items: {
							type: "object",
							properties: {
								label: { type: "string" },
								data: {
									type: "array",
									items: { type: "number" }
								},
								//color: { type: "string", description: "Hex #RRGGBB, overrides default color palette" }
							},
							required: ["label", "data"]
						}
					}
				},
				required: ["labels", "datasets"]
			},

			title: {
				type: "string",
				description: "Title of chart (optional)",
			},
			/*options: {
				type: "object",
				description: "Additional Chart.js options (e.g., scales, plugins).",
				example: { responsive: true }
			},*/

			height: {
				type: "integer",
				description: "(in pixels)"
			}
		},
		required: ["type", "data", "height"]
	},

	autorun: true,
	async script(options, context) {
		if (!options.data.datasets.length) throw new Error('至少需要一个数据集');

		const config = buildChartConfig(options);

		context[OPTIONS] = options;
		context[CHART] = $asyncState(() => {
			return import('./Chart.js').then(m => {
				Chart = m.default;
				const canvas = <canvas />;
				new Chart(canvas, config);
				canvas.style = "";
				return canvas;
			});
		});

		return "rendered to UI";
	},
	renderer(context, is_frozen) {
		const state = context[CHART];
		const options = context[OPTIONS];

		return $computed(() => {
			if (state.error) return errorBlock(state.error, "图表渲染失败");
			if (state.loading) return loadingBlock("图表加载中……");

			return <div style={{maxHeight: options.height+"px", display: "flex", justifyContent: "center"}}>{state.value}</div>;
		})
	}
}]);
