import {
	BarController,
	BarElement,
	Chart,
	DoughnutController,
	Filler,
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
	RadialLinearScale, LogarithmicScale,
	PointElement, LineElement, BarElement,
	Filler
]);

export default Chart;