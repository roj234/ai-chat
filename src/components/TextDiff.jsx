import {unconscious} from "unconscious";
import {textDiff} from "unconscious/common/text-diff.js";
import "./TextDiff.css";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {selectableVirtualListMixin} from "unconscious/common/selectableVirtualListMixin.js";
import {lightAsync, loadLanguage, splitMultilineHTML} from "../markdown/highlight.js";
import {fastObjectMap} from "../utils/pure-utils.js";

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

const TYPE_STR_MAP = fastObjectMap({
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

	if (hasLines && !diff.at(-1).line) {
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
		}

		if (prevHunk) {
			const startLine = start[hunkId-1];
			prevHunk.text = `@@ -${startLine},${delLine - startLine} +${startLine},${addLine - startLine} @@ `+prevHunk.text;
		}
	}

	const diffContainer = <pre className={'textDiff'+(hasLines?" has-lines":"")} />;
	const vl = new VirtualList({
		element: diffContainer,
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
	selectableVirtualListMixin(vl, (i) => {
		const d = diff[i];
		return TYPE_STR_MAP[d.type]+d.text;
	});


	const ext = loadLanguage(filename.slice(filename.lastIndexOf('.') + 1));
	if (ext) {
		ext.then(name => lightAsync(diff.map(d => d.text).join('\n'), name, (html) => {
			const lines = splitMultilineHTML(html, []);
			for (let i = 0; i < lines.length; i++) {
				diff[i].html = lines[i];
			}

			vl.dom.replaceChildren();
			vl.render();
		}, () => !diffContainer.isConnected));
	}

	return diffContainer;
}