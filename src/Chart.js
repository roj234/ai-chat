// Chart.js 图表工具前端实现
import "./chart.css";
import {loadChartJS} from "./async-loader.js";

export const ChartCreator = {
	charts: new Map(),

	// 预定义颜色数组
	colorPalette: [
		'#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF',
		'#FF9F40', '#FF6384', '#C9CBCF', '#4BC0C0', '#36A2EB'
	],

	/**
	 * 主要的图表创建方法
	 * @param {Object} config - 图表配置
	 */
	createChart(config) {
		// 验证必需参数
		this.validateConfig(config);

		// 获取或创建canvas元素
		const canvas = this.getOrCreateCanvas(config.chartId);

		// 构建Chart.js配置
		const chartConfig = this.buildChartConfig(config);

		loadChartJS().then(Chart => {
			// 创建图表
			const chart = new Chart(canvas, chartConfig);

			// 销毁已存在的图表
			if (this.charts.has(config.chartId)) {
				this.charts.get(config.chartId).destroy();
			}
			// 存储图表实例
			this.charts.set(config.chartId, chart);
		});
	},

	/**
	 * 验证配置参数
	 */
	validateConfig(config) {
		const required = ['chartId', 'type', 'data'];
		for (let param of required) {
			if (!config[param]) {
				throw new Error(`缺少必需参数: ${param}`);
			}
		}

		if (!config.data.labels || !config.data.datasets) {
			throw new Error('数据必须包含 labels 和 datasets');
		}

		if (config.data.datasets.length === 0) {
			throw new Error('至少需要一个数据集');
		}
	},

	/**
	 * 获取或创建canvas元素
	 */
	getOrCreateCanvas(chartId) {
		let canvas = document.getElementById(chartId);

		if (!canvas) {
			// 创建容器div
			const container = document.createElement('div');
			container.id = `${chartId}-container`;
			container.style.cssText = `
        position: relative;
        width: 100%;
        height: 400px;
        margin: 20px 0;
        background: white;
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        padding: 20px;
      `;

			// 创建canvas元素
			canvas = document.createElement('canvas');
			canvas.id = chartId;
			canvas.style.cssText = 'width: 100%; height: 100%;';

			container.appendChild(canvas);
			document.body.appendChild(container);
		}

		return canvas;
	},

	/**
	 * 构建Chart.js配置对象
	 */
	buildChartConfig(config) {
		const { type, data, options = {} } = config;

		// 构建数据集
		const datasets = this.buildDatasets(data.datasets, config);

		// 构建基础配置
		return {
			type: type,
			data: {
				labels: data.labels,
				datasets: datasets
			},
			options: this.buildOptions(type, options)
		};
	},

	/**
	 * 构建数据集
	 */
	buildDatasets(datasets, config) {
		return datasets.map((dataset, index) => {
			const colorIndex = index % this.colorPalette.length;
			const baseColor = this.colorPalette[colorIndex];

			return {
				...dataset,
				backgroundColor: dataset.backgroundColor || this.getBackgroundColors(baseColor, config.type),
				borderColor: dataset.borderColor || baseColor,
				borderWidth: dataset.borderWidth || 2,
				fill: dataset.fill !== undefined ? dataset.fill : (config.type !== 'line')
			};
		});
	},

	/**
	 * 根据颜色获取背景色数组
	 */
	getBackgroundColors(color, type) {
		if (['pie', 'doughnut'].includes(type)) {
			// 饼图和环形图使用多种颜色
			return this.colorPalette.slice(0, 8);
		} else {
			// 其他图表类型使用透明度
			return this.hexToRgba(color, 0.2);
		}
	},

	/**
	 * 构建图表选项
	 */
	buildOptions(type, options) {
		const defaultOptions = {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				title: {
					display: false
				},
				legend: {
					display: true,
					position: 'top',
					labels: {
						usePointStyle: true,
						padding: 20
					}
				}
			}
		};

		// 为特定图表类型添加特定选项
		if (type === 'line') {
			defaultOptions.scales = {
				x: {
					display: true,
					grid: {
						display: true
					}
				},
				y: {
					display: true,
					beginAtZero: true,
					grid: {
						display: true
					}
				}
			};
		}

		// 合并用户自定义选项
		return this.deepMerge(defaultOptions, options);
	},

	/**
	 * 深度合并对象
	 */
	deepMerge(target, source) {
		const result = { ...target };

		for (const key in source) {
			if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
				result[key] = this.deepMerge(target[key] || {}, source[key]);
			} else {
				result[key] = source[key];
			}
		}

		return result;
	},

	/**
	 * 十六进制颜色转RGBA
	 */
	hexToRgba(hex, alpha) {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	},

	/**
	 * 销毁所有图表
	 */
	destroyAllCharts() {
		this.charts.forEach((chart, chartId) => {
			chart.destroy();
		});
		this.charts.clear();
	},

	/**
	 * 更新图表数据
	 */
	updateChart(chartId, newData) {
		const chart = this.charts.get(chartId);
		if (!chart) {
			throw new Error(`图表 "${chartId}" 不存在`);
		}

		chart.data = newData;
		chart.update();
	},

	getChart(chartId) {
		return this.charts.get(chartId);
	}
};