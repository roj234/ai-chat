import {$computed, unconscious} from "unconscious";
import {textDiff} from "/common/text-diff.js";
import "./TextDiff.css";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {selectableVirtualListMixin} from "unconscious/common/selectableVirtualListMixin.js";

/**
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {boolean} strip
 * @constructor
 */
export const TextDiff = ({
	oldText, newText, strip
}) => {
	return $computed(() => {
		const oldLines = unconscious(oldText).split('\n');
		const newLines = unconscious(newText).split('\n');
		if (oldLines.length === 1 && !oldLines[0]) oldLines.pop();
		if (newLines.length === 1 && !newLines[0]) newLines.pop();
		const diff = textDiff(oldLines, newLines, strip);
		const opRenderer = op => <div className={'line ' + op.type}><span className="text">{op.text}</span></div>;

		let diffDiv;
		let count = {};
		diff.forEach(op => count[op.type] = (count[op.type]||0) + 1);
		return <pre className={'textDiff'}>
			<div className="code-header">
				<span>
					{diff.length > 3 && <button className="ghost" onClick={({target}) => {
						target.textContent = target.closest('pre').classList.toggle('open') ? '显示更少' : '显示更多';
						if (diffDiv) {
							diffDiv.replaceChildren();
							const vl = new VirtualList({
								element: diffDiv,
								data: diff,
								itemHeight: 21,
								renderer: opRenderer
							});
							selectableVirtualListMixin(vl, (line) => diff[line].text);
							diffDiv = null;
						}
					}}>显示更多</button>}
				</span>
				<span>
					{count.add&&<b style={"color:var(--ok)"}>+{count.add || 0}</b>} {count.del&&<b style={"color:var(--error)"}>-{count.del}</b>}
				</span>
			</div>
			<div ref={diffDiv} className={'diff'}>{diff.slice(0, 3).map(opRenderer)}</div>
		</pre>
	});
}