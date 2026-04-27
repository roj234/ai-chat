import {registerCodeBlockRenderer} from "/src/markdown/markdown.js";

let mermaid;
let renderQueue;

registerCodeBlockRenderer("mermaid", (code, language, node, is_finished) => {
	if (!renderQueue) {
		const moduleUrl = import.meta.env.DEV ? new URL('/mermaid.esm.min.mjs', import.meta.url).href : './mermaid.esm.min.mjs';
		renderQueue = import(/* @vite-ignore */moduleUrl).then(module => {
			mermaid = module.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "antiscript"
			});
		});
	}

	if (!is_finished) return true;

	// for [copy code] button
	node.dataset.text = code;
	node.textContent = code;

	renderQueue = renderQueue.then(async () => {
		if (node.isConnected) {
			node.classList.remove("error");
			delete node.dataset.processed;

			try {
				await mermaid.run({ nodes: [node] });
			} catch (err) {
				node.classList.add("error");
				node.textContent = err.message;
			}
		}
	});
});
