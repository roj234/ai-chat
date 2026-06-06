import morphdom from 'morphdom';
import './markdown-editor.css';
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {appendChildren} from "unconscious";

let editor,fileTitle,preview;

const syncTitle = (text) => {
	document.title = (fileTitle.value || text).replace(/[\r\n]/g, '').trim() || '未命名文档';
};

const updatePreview = () => {
	const markdownText = editor.value;

	const newPreviewNode = <div id={"preview"} className={"markdown-body"}></div>;
	renderMarkdownToElement(newPreviewNode, markdownText, {noHighlight: true});

	Promise.resolve().then(() => {
		morphdom(preview, newPreviewNode);

		const firstHeader = preview.querySelector('h1, h2');
		if (firstHeader) syncTitle(firstHeader.innerText);
	});

	sessionStorage.setItem('text', markdownText);
};

const App = <>
	<header className="toolbar">
		<div className="title-group">
			<span className="label">文档标题:</span>
			<input type="text" id={"file-title"} ref={fileTitle} placeholder="留空从文件提取" onInput={() => {
				syncTitle(fileTitle.value);
			}} />
		</div>
		<div className="actions">
			<button onClick={() => {
				const text = editor.value;
				const blob = new Blob([text], {type: 'text/markdown'});
				const url = URL.createObjectURL(blob);

				const a = document.createElement('a');
				a.href = url;
				a.download = 'document.md';
				a.click();

				URL.revokeObjectURL(url);
			}}>💾 保存</button>
			<button onClick={() => window.print()}>🖨️ 打印</button>
		</div>
	</header>

	<main className="container">
		<textarea id={"editor"} ref={editor} onInput={updatePreview} placeholder="在此输入 Markdown 内容... 支持 LaTeX 公式如 $E=mc^2$"
		value={sessionStorage.getItem('text') ||  `# Markdown 打印机

这是一个 **实时预览** 的 Markdown 编辑器。

## 数学公式 (KaTeX)
行内公式: $E=mc^2$

块级公式:
$$
\\frac{1}{\\Bigl(\\sqrt{\\phi \\sqrt{5}}-\\phi\\Bigr) e^{\\frac25 \\pi}} = 1+\\frac{e^{-2\\pi}}{1+e^{-4\\pi}}
$$

## 代码块
\`\`\`javascript
console.log("Hello World");
\`\`\`

> 点击右上角的打印按钮可以将此视图另存为 PDF。
`} />
		<section className="preview-pane"><div ref={preview} className="markdown-body"></div></section>
	</main>
</>;

const app = document.body;
app.replaceChildren();
appendChildren(app, App);
updatePreview();