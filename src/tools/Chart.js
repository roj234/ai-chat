import {
	ArcElement,
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	DoughnutController,
	Filler,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	LogarithmicScale,
	PieController,
	PointElement,
	PolarAreaController,
	RadarController,
	RadialLinearScale,
	ScatterController,
	Title,
	Tooltip
} from "../../vendor/chartjs/chart.js";
import {throttled} from "../utils.js";

Chart.register(
	ArcElement,
	BarController,
	BarElement,
	CategoryScale,
	DoughnutController,
	Filler,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	LogarithmicScale,
	PieController,
	PointElement,
	PolarAreaController,
	RadarController,
	RadialLinearScale,
	ScatterController,
	Tooltip,
	Title
);

const resizeCharts = throttled(() => {
	for (const chart of Object.values(Chart.instances)) {
		chart.resize();
	}
}, 16);
window.addEventListener("resize", resizeCharts);

const applyChartDarkMode = (isDark) => {
	const textColor = isDark ? '#f8f9fa' : '#212529';
	const gridColor = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.1)';

	const options = Chart.defaults;
	//options.maintainAspectRatio = false;
	options.color = textColor;
	options.scale.grid.color = gridColor;
	options.plugins.title.position = "bottom";

	const tooltip = options.plugins.tooltip;
	tooltip.backgroundColor = isDark ? '#333' : '#fff';
	tooltip.borderColor = gridColor;
	tooltip.borderWidth = 1;
};

applyChartDarkMode(true);

export default Chart;