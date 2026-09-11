import {unconscious} from "unconscious";
import {textDiff} from "unconscious/common/text-diff.js";
import "./TextDiff.css";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {selectableVirtualListMixin} from "unconscious/common/selectableVirtualListMixin.js";
import {lightAsync, loadLanguage, splitMultilineHTML} from "../markdown/highlight.js";
import {immutableObjectMap} from "unconscious/common/Utils.js";

/**
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {boolean} stripCommon
 */
export const makeDiff = (oldText, newText, stripCommon = false) => {
	const oldLines = !oldText ? [] : unconscious(oldText).split('\n');
	const newLines = !newText ? [] : unconscious(newText).split('\n');
	return textDiff(oldLines, newLines, stripCommon);
}

export const DiffHeader = ({diff}) => {
	let count = diff.count;
	if (!count) {
		count = diff.count = {};
		diff.forEach(op => count[op.type] = (count[op.type]||0) + 1);
	}
	return <>{count.add && <span style={"color:var(--ok)"}>+{count.add}</span>} {count.del && <span style={"color:var(--error)"}>-{count.del}</span>}</>;
};

const TYPE_STR_MAP = immutableObjectMap({
	add: '+ ',
	del: '- ',
	same: '  ',
	hunk: ''
});

/**
 * @param {number[]} start
 * @param {ReturnType<textDiff>} diff
 * @param {string} filename
 * @constructor
 */
export const TextDiff = ({ start, diff, filename = '' }) => {
	const hasLines = start.length;
	let ls;

	if (hasLines && !(ls = diff.at(-1).line)) {
		ls = 0;
		let addLine = start[0];
		let delLine = addLine;
		let prevHunk;
		let hunkId = 0;
		for (const d of diff) {
			const type = d.type;
			switch (type) {
				case 'hunk':
					if (prevHunk) {
						const startLine = start[hunkId-1];
						prevHunk.text = `@@ -${startLine},${delLine - startLine} +${startLine},${addLine - startLine} @@ `+prevHunk.text;
					}
					addLine = delLine = start[hunkId];
					prevHunk = d;
					hunkId++;
				break;
				case "add": d.line = addLine++; break;
				case "del": d.line = delLine++; break;
				case "same": d.line = addLine++; delLine++; break;
			}
			ls = Math.max(ls, addLine, delLine);
		}

		if (prevHunk) {
			const startLine = start[hunkId-1];
			prevHunk.text = `@@ -${startLine},${delLine - startLine} +${startLine},${addLine - startLine} @@ `+prevHunk.text;
		}
	}
	const lw = ls ? String(ls).length + 4 : 3;

	const container = <pre className={'textDiff'} style={`--lw:${lw}ch`} />;
	const vl = new VirtualList({
		element: container,
		data: diff,
		itemHeight: 21,
		renderer: ({type, html, text, line}, i) => {
			return (type === 'hunk'
				? <div className={"line hunk"}>{text}</div>
				: <div className={'line ' + type}>
					<span className={"no"}>{(line ? line + " " : "") + TYPE_STR_MAP[type]}</span>
					{html ? <span className={"text"} dangerouslySetInnerHTML={html}/> :
						<span className="text">{text}</span>}
				</div>);
		}
	});
	selectableVirtualListMixin(vl, (i) => diff[i].text, true);

	const ext = loadLanguage(filename.slice(filename.lastIndexOf('.') + 1));
	if (ext) {
		ext.then(name => lightAsync(diff.map(d => d.text).join('\n'), name, (html) => {
			const lights = splitMultilineHTML(html, []);
			for (let i = 0; i < lights.length; i++) {
				diff[i].html = lights[i];
			}

			vl.dom.replaceChildren();
			vl.render();
		}, () => !container.isConnected));
	}

	return container;
}

/**
 * @param {number} start
 * @param {string} code
 * @param {string} filename
 * @constructor
 */
export const HighlightBox = ({ start = 1, code, filename = '' }) => {
	const lines = code.split('\n').map(text => ({ text }));
	const last = String(start + lines.length).length + 2;
	const container = <pre className={"textDiff"} style={`--lw:${last}ch`} />;

	const vl = new VirtualList({
		element: container,
		data: lines,
		itemHeight: 21,
		renderer: ({html, text}, line) => {
			return <div className={'line'}>
				<span className={"no"}>{(line+start) > 0 && (line+start) + " "}</span>
				{html ? <span className={"text"} dangerouslySetInnerHTML={html}/> : <span className="text">{text}</span>}
			</div>;
		}
	});
	selectableVirtualListMixin(vl, (i) => lines[i].text, true);


	const ext = loadLanguage(filename.slice(filename.lastIndexOf('.') + 1));
	if (ext) {
		ext.then(name => lightAsync(code, name, (html) => {
			const lights = splitMultilineHTML(html, []);
			for (let i = 0; i < lights.length; i++) {
				lines[i].html = lights[i];
			}

			vl.dom.replaceChildren();
			vl.render();
		}, () => !container.isConnected));
	}

	return container;
}