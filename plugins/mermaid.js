import {registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {getCurrentTheme} from "/src/states.js";
import {PLACEHOLDERS} from "../src/toolset.js";

PLACEHOLDERS['mdfmt'] += `
- Render mermaid:
   \`\`\`mermaid
   [content]
   \`\`\``;

export const registerMermaidRenderer = () => {
	let mermaid;
	let renderQueue;

	registerCodeBlockRenderer("mermaid", (code, language, node, is_finished) => {
		if (!renderQueue) {
			const moduleUrl = import.meta.env.DEV ? new URL('/assets/mermaid.min.mjs', import.meta.url).href : './mermaid.min.mjs';
			renderQueue = import(/* @vite-ignore */moduleUrl).then(module => {
				mermaid = module.default;
				mermaid.initialize({
					startOnLoad: false,
					theme: getCurrentTheme() === 'dark' ? 'dark' : 'default',
					securityLevel: "antiscript"
				});
			});
		}

		if (!is_finished) return true;

		// for [copy code] button
		node.dataset.text = code;

		renderQueue = renderQueue.then(async () => {
			if (node.isConnected) {
				delete node.dataset.processed;

				try {
					await mermaid.run({ nodes: [node] });
					node.className = "mermaid";
				} catch (err) {
					node.className = "error";
					node.textContent = err.message;
				}
			}
		});
	});
}