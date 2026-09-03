import "./BorderSpinner.css";

export const BorderSpinner = ({color, borderRadius = "0", borderWidth = "2px"}) => {
	let line;
	const ro = new ResizeObserver(() => {
		line.classList.remove("_s");
		requestAnimationFrame(() => {
			line.classList.add("_s");
		});
	});
	const svg = <svg className="border-spinner" style={"--cl:"+color+";--bw:"+borderWidth}>
		<rect ref={line} className="_s _line" rx={borderRadius} ry={borderRadius} pathLength="100"/>
	</svg>;
	ro.observe(svg);
	return svg;
}