import "./BorderSpinner.css";
import {$cleanup} from "unconscious";

const ro = new ResizeObserver((entries) => {
	for (const entry of entries) {
		const rect = entry.target.firstElementChild.style;
		const box = entry.contentRect;
		rect.width = box.width+"px";
		rect.height = box.height+"px";
	}
});

export const BorderSpinner = ({color, borderRadius = "0", borderWidth = "2px"}) => {
	const svg = <svg className="border-spinner" style={"--cl:"+color+";--bw:"+borderWidth}>
		<rect className="_line" rx={borderRadius} ry={borderRadius} pathLength="100"/>
	</svg>;
	ro.observe(svg);
	$cleanup(svg, () => ro.unobserve(svg));
	return svg;
}