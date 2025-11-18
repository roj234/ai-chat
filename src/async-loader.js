
export let loadMermaid = async () => {
	const obj = (await import('../assets/mermaid/mermaid.esm.min.mjs')).default;
	obj.initialize({
		startOnLoad: false,
		securityLevel: "antiscript"
	});
	loadMermaid = () => Promise.resolve(obj);
	return obj;
};

/*export let loadHighlightJS = async () => {
	const obj = (await import('../assets/highlight.min.js')).default;
	loadHighlightJS = () => Promise.resolve(obj);
	return obj;
}*/

export let loadChartJS = async () => {
	const obj = (await import('./ChartJS.async.js')).default;
	loadChartJS = () => Promise.resolve(obj);
	return obj;
}