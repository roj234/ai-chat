import {
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	DoughnutController,
	Filler,
	LinearScale,
	LineController,
	LineElement,
	LogarithmicScale,
	PieController,
	PointElement,
	PolarAreaController,
	RadarController,
	RadialLinearScale,
	ScatterController
} from "chart.js";

Chart.register([
	LineController, BarController, RadarController, PolarAreaController, PieController, DoughnutController, ScatterController,
	LinearScale, RadialLinearScale, LogarithmicScale, CategoryScale,
	PointElement, LineElement, BarElement,
	Filler
]);

export default Chart;