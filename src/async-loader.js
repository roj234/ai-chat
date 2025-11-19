
export let loadMermaid = async () => {
	const obj = (await import('../assets/mermaid/mermaid.esm.min.mjs')).default;
	obj.initialize({
		startOnLoad: false,
		securityLevel: "antiscript"
	});
	loadMermaid = () => Promise.resolve(obj);
	return obj;
};