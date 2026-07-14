// Chart.js 图表工具前端实现
import {getToolParameters, registerToolset} from "/src/toolset.js";
import {$asyncState, $computed, $watch, debugSymbol} from "unconscious";
import {selectedConversation} from "/src/states.js";
import {errorBlock, loadingBlock} from "/src/utils/utils.js";
import {fileAccess} from "./fileAccess.js";
import {readAsString} from "/common/chardet.js";
import {parseCsv} from "/common/loadCsv.js";

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

/**
 *
 * @param {string} path
 * @param {Blob|string} blob
 * @returns {Promise<string[][]>}
 */
async function parseCsvTsv(path, blob) {
	const csvText = typeof blob === 'string' ? blob : await readAsString(blob);
	return parseCsv(csvText, {
		delimiter: path.toLowerCase().endsWith('.tsv') ? '\t' : ','
	});
}

registerToolset("Chart", "Create charts and data visualizations from CSV files.", [{
	name: "Chart",
	description: "Create Chart.js visualizations from structured numeric data."
		+" Use when visual comparison or trend understanding is useful."
	,
	parameters: {
		type: "object",
		properties: {
			type: { enum: ["line", "bar", "radar", "polarArea", "pie", "doughnut", "scatter"] },

			path: {
				type: "string",
				description: "CSV / TSV dataset in workspace",
			},
			content: {
				type: "string",
				description: 'Inline file content (deprecated)'
			},
			delimiter: {
				type: "string",
				default: "'\t' for .tsv and ',' for other (e.g., inline or .csv)",
				minLength: 1,
				maxLength: 1
			},
			xLabels: {
				type: "array",
				description: "Array of labels for the X-axis (or categories). Omit to use first column",
				items: { type: "string" }
			},
			yLabels: {
				type: 'array',
				description: 'Y-axis labels. Omit to use first row',
				items: { type: 'string' }
			},
			datasetOptions: {
				type: 'array',
				items: { type: 'object' },
				description: "Additional Chart.js options for each dataset (e.g., backgroundColor)."
			},

			title: {
				type: "string",
				description: "Title of chart (optional)",
			},

			options: {
				type: "object",
				description: "Additional Chart.js global options (e.g., scales, plugins).",
				default: { responsive: true }
			},
		},
		required: ["type"]
	},
	title(tc, ctx) {
		const arg = getToolParameters(ctx, tc);
		let title = "绘制" + (arg.title || '图表');
		if (arg.path) title += " ("+arg.path+")";
		return title;
	},

	reentrant: 'stateless',
	async script({
		type, title,
		path, content,
		delimiter,
		xLabels, yLabels,
		datasetOptions, options,
	}, context, conv) {
		const readFile = fileAccess('readRaw');

		if (!path && !content) throw 'Error: Neither path nor content was provided.';

		context[CHART] = $asyncState(async () => {
			let columns = context.columns;
			if (!columns) {
				const blob = path ? await readFile({path}, null, conv) : content;
				if (blob.size > 65536) throw new Error('File '+ path+' too big (64KB)');
				const rows = await parseCsvTsv(path, blob);
				const columnCount = rows[0].length;
				columns = Array.from({ length: columnCount }).map(() => ([]));

				// transpose
				for (let i = 0; i < rows.length; i++){
					const row = rows[i];
					for (let j = 0; j < row.length; j++)
						columns[j].push(row[j]);
				}

				context.columns = structuredClone(columns);
			} else {
				columns = structuredClone(columns);
			}

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

			if (!xLabels) {
				xLabels = columns.shift();
				xLabels.shift();
			}

			const chartJsOptions = {
				type,
				data: {
					labels: xLabels,
					datasets: columns.map((data, index) => {
						const baseColor = colorPalette[index % colorPalette.length];
						const options = datasetOptions?.[index] || {};
						const label = yLabels?.[index] || data.shift();
						return {
							label,
							data,
							backgroundColor: options.backgroundColor || (isPie ? colorPalette : hexToRgba(baseColor, 0.2)),
							borderColor: options.borderColor || (isPie ? "#fff" : baseColor),
							borderWidth: options.borderWidth || 2,
							fill: options.fill !== undefined ? options.fill : (type !== 'line')
						};
					})
				},
				options: Object.assign(defaultOptions, options)
			};

			context[OPTIONS] = chartJsOptions;
			return import('./chart.async.js').then(m => {
				Chart = m.default;
				const canvas = <canvas />;
				new Chart(canvas, chartJsOptions);
				canvas.style = "";
				return canvas;
			});
		});

		return "Successfully displayed to user";
	},
	renderer(context, is_frozen) {
		const state = context[CHART];

		return $computed(() => {
			if (state.error) return errorBlock(state.error, "图表渲染失败");
			if (state.loading) return loadingBlock("图表加载中……");

			return <div style={{maxHeight: "30vh", display: "flex", justifyContent: "center"}}>{state.value}</div>;
		})
	}
}], {
	depend: ['Files']
});
