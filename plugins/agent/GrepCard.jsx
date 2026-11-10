import {compileGrepPattern} from "/common/fs-common.js";

import "./GrepCard.css";
import {$vforeach} from "unconscious";
import {debugSymbol} from "@roj234/shared";

const EXPANDED = debugSymbol("Expanded");
const OMITTED = /\[\.\.\. (?:omitted end of long line|\d+ more matches)]$/;

/**
 * @param {string} pattern
 * @param {string} content
 * @param {string} path
 * @param collapsedByDefault
 * @return {JSX.Element|boolean}
 */
export function grepCard(pattern, content, path, collapsedByDefault = false) {
	const regexp = compileGrepPattern(pattern);

	let matchCount = 0;

	const chunks = content.trim().split("\n\n");
	const parseMatches = l => {
		if (l === '--') return {type: 'hunk', text: "•••"};

		// 兼容 \x1F 或常见冒号分隔
		let splitIdx = l.indexOf('\x1f');
		if (splitIdx === -1) splitIdx = l.indexOf('-');
		else matchCount++;
		return {
			line: l.substring(0, splitIdx).trim(),
			text: l.substring(splitIdx + 1)
		};
	};

	const files = chunks.length > 1 || isNaN(parseInt(chunks[0][0])) ? chunks.map(chunk => {
		const lines = chunk.split('\n');
		const path = lines[0].trim();
		let prevMatches = matchCount;
		const matches = lines.slice(1).map(parseMatches);
		return {path, matches, matchCount: matchCount - prevMatches};
	}) : [{
		path: '',
		matches: chunks[0].split('\n').map(parseMatches)
	}];

	function escapeAndHighlight(str) {
		const div = <div>{str}</div>;
		return div.innerHTML.replace(regexp, '<mark>$&</mark>');
	}

	if (!matchCount) return false;

	return <div className={"grep-card"}>
		{$vforeach(files, file => {
			return <details open={file[EXPANDED] ?? !collapsedByDefault} onToggle={e => {
				file[EXPANDED] = e.target.open;
			}}>
				<summary>
					<span className="chevron ri-play-large-fill"/>
					<span className="-path">{(!path || path === '.' ? '' : path + '/') + file.path}</span>
					<span className="spacer"/>
					<span className="-badge">{file.matchCount} 匹配</span>
				</summary>
				<pre className={"textDiff"} style={"--lw:7ch"}>
						{file.matches.map(match => {
							const text = match.text;
							if (match.type === 'hunk') {
								return <div className={"line hunk"}>{text}</div>
							} else {
								const arr = OMITTED.exec(text);
								const end = arr ? arr.index : text.length;
								return <div className={"line"}>
									<span className={"no"}>{match.line + " "}</span>
									<span className={"text"} dangerouslySetInnerHTML={escapeAndHighlight(text.slice(0, end))}>
										{arr && <i className="-omit">{arr[0]}</i>}
									</span>
								</div>
							}
						})}
					</pre>
			</details>
		})}
	</div>
}