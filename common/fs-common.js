import {createAsyncQueue} from "../src/utils/pure-utils.js";
import {LRUCache} from "./LRUCache.js";

export const GREP_MAX_COLUMNS = 180;

/**
 *
 * @param {{
 *     list: Function,
 *     absPath: function(string, any): string,
 *     read: (function(string, any): Promise<string>),
 *     write: (function(string, string, any): Promise<void>),
 *     mtime: (function(string, any): Promise<number>)
 * }} fs
 */
export function createTextFileEditHelper(fs) {
	/**
	 * @type {Map<string, string[]>}
	 */
	const cache = new LRUCache(200);

	const readLines = async (path, ctx) => {
		const absPath = fs.absPath(path, ctx);

		let cached = cache.get(absPath);
		const mtime = await fs.mtime(absPath, ctx);
		if (cached && Math.abs(mtime - cached.mtime) < 500) return cached;

		const str = await fs.read(absPath, ctx);
		const lines = str.split(/\r?\n/);
		lines.mtime = mtime;
		cache.set(absPath, lines);
		return lines;
	};

	const leadingWhitespace = line => /^\s*/.exec(line)[0];

	const formatLineRanges = (matches, lengths, limit = 8) => {
		const ranges = matches.slice(0, limit).map((start, i) => {
			const length = Array.isArray(lengths) ? lengths[i] : lengths;
			return length > 1 ? `${start + 1}-${start + length}` : `${start + 1}`;
		});
		return ranges.join(', ') + (matches.length > limit ? `, … (${matches.length} total)` : '');
	};

	const findLineBlockMatches = (lines, searchLines) => {
		const matches = [];
		const n = searchLines.length;
		let from = 0;

		while (from + n <= lines.length) {
			const index = lines.indexOf(searchLines[0], from);
			if (index < 0) break;
			let matched = true;
			for (let i = 1; i < n; i++) {
				if (lines[index + i] !== searchLines[i]) {
					matched = false;
					break;
				}
			}
			if (matched) matches.push(index);
			from = index + 1;
		}
		return matches;
	};

	const findStringMatchLines = (content, search, lineOffset = 0) => {
		const result = [];
		let index = -1;
		while ((index = content.indexOf(search, index + 1)) !== -1) {
			let line = lineOffset + 1;
			for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
			result.push(line - 1); // formatLineRanges expects zero-based positions
		}
		return result;
	};

	/**
	 * Models sometimes copy a block with the right relative indentation but a
	 * wrong base indentation. Rebase both search and replacement to each file
	 * candidate; the caller still requires the resulting match to be unique.
	 */
	const findReindentedMatches = (lines, searchLines, replaceLines) => {
		const first = searchLines[0];
		const baseIndent = leadingWhitespace(first);
		const firstBody = first.slice(baseIndent.length);
		if (!firstBody) return { matches: [], reason: 'the first search line contains only whitespace' };

		// Blank lines carry no meaningful indentation. Every other line must be
		// at least as deeply indented as the first so rebasing cannot change the
		// relative structure by removing non-whitespace characters.
		if (searchLines.some(line => line.trim() && leadingWhitespace(line).length < baseIndent.length)) {
			return { matches: [], reason: 'a later search line is less indented than the first line' };
		}

		const firstCandidates = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trimStart() === firstBody) firstCandidates.push(i);
		}

		const matches = [];
		for (const index of firstCandidates) {
			const targetIndent = leadingWhitespace(lines[index]);
			const rebase = sourceLines => sourceLines.map(line => {
				if (!line.trim()) return line;
				return targetIndent + line.slice(Math.min(baseIndent.length, leadingWhitespace(line).length));
			});
			const rebasedSearch = rebase(searchLines);
			let matched = index + rebasedSearch.length <= lines.length;
			for (let i = 0; matched && i < rebasedSearch.length; i++) matched = lines[index + i] === rebasedSearch[i];
			if (matched) matches.push({ index, searchLines: rebasedSearch, replaceLines: rebase(replaceLines) });
		}

		return {
			matches,
			firstCandidates,
			reason: firstCandidates.length ? 'candidate first lines were found, but their following lines did not match after indentation rebasing' : 'no line has the same first-line text after removing leading whitespace'
		};
	};

	const read = async ({ path, offset, limit, maxChars = 50000, format = 'raw', noTruncate }, ctx) => {
		let needWarning;

		const lines = await readLines(path, ctx);

		const lineCount = lines.length;

		let first = offset != null ? offset - 1 : 0;
		if (first < 0) {
			if (first === -1) throw new Error("Offset must be non-zero");
			const pos = first + lineCount + 1;
			if (pos >= 0) { first = pos; }
			else { first = 0; needWarning = 'offset'; }
		} else {
			if (first >= lineCount) return ("\x02\x03\nOFFSET_TOO_LARGE: Only "+lineCount+" lines");
		}

		let last  = limit != null ? first + limit : lineCount;
		if (last > lineCount) { last = lineCount; needWarning = 'limit'; }

		if (format === 'frontmatter') {
			let end;
			return lines[0] === '---' && (end = lines.indexOf('---', 1)) > 0 ? lines.slice(0, end+1).join('\n') : '';
		}

		if (noTruncate) return lines.slice(first, last).join('\n');

		let truncated = 0;
		const respLines = [];

		for (let i = first; i < last; i++) {
			const line = lines[i];
			if (maxChars < line.length) {
				truncated = `${last - i} lines before line#${i + 1} (length: ${line.length})`;
				break;
			}
			maxChars -= line.length;

			let text;
			switch (format) {
				case 'raw':     text = line; break;
				default:        text = (i + 1) + '\x1F' + line; break; // UnitSep
			}
			respLines.push(text);
		}

		let content = respLines.join('\n') + '\x03';
		if (truncated || needWarning) {
			if (truncated) content += `\nTRUNCATED(maxChars): Only ${respLines.length} of ${last - first} (${lineCount} total) lines shown`;
			if (needWarning) content += `\nOVERFLOW(${needWarning}): Only ${last - first} lines available in requested range (${lineCount} total lines)`;
		} else if (last === lineCount) {
			content += 'EOF';
		} else {
			content += `Total lines: ${lineCount}`;
		}
		return content;
	};

	const patch = async ({path, changes}, ctx) => {
		const lines = await readLines(path, ctx);
		const patches = [];

		let errors = [];

		for (let i = 0; i < changes.length; i++) {
			const {search, replace} = changes[i];
			if (search === replace) continue;
			if (!search) {
				errors.push(`Hunk #${i + 1} is invalid: search is empty.`);
				continue;
			}

			let searchLines = search.split('\n');
			let replaceLines = replace.split('\n');

			const n = searchLines.length;
			let matches = findLineBlockMatches(lines, searchLines);
			if (matches.length > 1) {
				errors.push(`Hunk #${i + 1} is ambiguous: ${matches.length} matches were found at line(s) ${formatLineRanges(matches, n)}.
Add more unchanged context around this hunk so it identifies one location.`);
				continue;
			}

			let reindent;
			if (!matches.length) {
				reindent = findReindentedMatches(lines, searchLines, replaceLines);
				matches = reindent.matches.map(match => match.index);
				if (reindent.matches.length === 1) {
					searchLines = reindent.matches[0].searchLines;
					replaceLines = reindent.matches[0].replaceLines;
				}
			}
			if (matches.length > 1) {
				errors.push(`Hunk #${i + 1} is ambiguous: Exact search failed, and automatic reindent found ${reindent.firstCandidates.length} matches at line(s): ${formatLineRanges(reindent.firstCandidates, 1)}.
Add more unchanged context and/or correct indentation for this hunk so it identifies one location.`);
				continue;
			}

			if (!matches.length) {
				let info = '';
				if (reindent.reason) {
					info += `\nAutomatic reindent failed because ${reindent.reason}`;
				}
				if (reindent.firstCandidates?.length) {
					info += `\nIndentation-insensitive candidate(s): ${formatLineRanges(reindent.firstCandidates, 1)}.`;
				}

				errors.push(`Hunk #${i + 1} was not found.${info}`);
				continue;
			}

			patches.push([ matches[0], matches[0] + n, replaceLines ]);
		}

		if (errors.length)
			throw errors.join('\n\n')+'\n\nNo changes were written.';

		patches.sort(([astart], [bstart]) => astart - bstart);
		for (let i = 1; i < patches.length; i++) {
			const [curStart, curEnd] = patches[i];
			const [prevStart, prevEnd] = patches[i - 1];
			if (curStart < prevEnd)
				throw (`Hunk ${i+2} [${curStart}, ${curEnd}] overlaps with hunk ${i+1} [${prevStart}, ${prevEnd}].`);
		}

		const newLines = [];
		let lastIndex = 0;
		let msg = 'Success.';

		for (let i = 0; i < patches.length; i++) {
			const [ start, end, replaceLines ] = patches[i];
			newLines.push(...lines.slice(lastIndex, start));

			const startLine = newLines.length + 1;
			const endLine = startLine + Math.max(0, replaceLines.length - 1);
			msg += `\nChanged lines: ${startLine}-${endLine}`;

			newLines.push(...replaceLines);
			lastIndex = end;
		}
		newLines.push(...lines.slice(lastIndex));

		newLines.mtime = Date.now();
		const absPath = fs.absPath(path, ctx);
		await fs.write(absPath, newLines.join('\n'), ctx);
		cache.set(absPath, newLines);

		const delta = newLines.length - lines.length;
		return msg+`
Lines: ${lines.length} → ${newLines.length} (${delta > 0 ? '+': ''}${delta})`;
	};

	const countLines = (content) => {
		const end = content.length;

		let count = 1;
		let index = content.indexOf('\n');

		while (index !== -1 && index < end) {
			count++;
			index = content.indexOf('\n', index + 1);
		}

		return count;
	};

	const edit = async ({ path, search, replace, replaceAll, startLine, endLine }, ctx) => {
		if (search === replace) throw ('"search" cannot equals to "replace"');
		if (!search) throw '"search" is empty';

		const lines = await readLines(path, ctx);
		const actualStart = (startLine ?? 1) - 1;
		const actualEnd = endLine ?? lines.length;
		const slice = lines.slice(actualStart, actualEnd);
		if (!slice.length) throw (`file slice [${startLine}, ${endLine}] is empty!`);
		const content = slice.join("\n");

		let delta;
		let msg = 'Success.';

		let newContent;
		if (replaceAll) {
			let lastIdx = content.indexOf(search);
			if (lastIdx < 0) throw (`"search" was not found in lines ${actualStart + 1}-${actualEnd}.`);

			const prefix = content.slice(0, lastIdx);
			newContent = prefix + replace + content.slice(lastIdx + search.length).replaceAll(search, replace);
			delta = countLines(newContent) - countLines(content);
		} else {
			let count = 0, lastIdx = -1, idx = -1;
			while ((idx = content.indexOf(search, idx + 1)) !== -1) {
				count++;
				lastIdx = idx;
			}
			if (count > 1) {
				const matchLines = findStringMatchLines(content, search, actualStart);
				throw (`Found ${count} occurrences of the search string at line(s) ${formatLineRanges(matchLines, countLines(search))}.
The search must identify one location; add distinguishing surrounding lines or narrow startLine/endLine.
No changes were written.`);
			}

			let effectiveSearch = search;
			let effectiveReplace = replace;
			if (count === 0) {
				const wholeFile = lines.join('\n');
				if (wholeFile.indexOf(search) >= 0) {
					const matchLines = findStringMatchLines(wholeFile, search);
					throw (`"search" exists outside the requested lines ${actualStart + 1}-${actualEnd}, at line(s) ${formatLineRanges(matchLines, countLines(search))}.
Adjust startLine/endLine or omit them.
No changes were written.`);
				}

				const reindent = findReindentedMatches(slice, search.split('\n'), replace.split('\n'));
				if (reindent.matches.length > 1) {
					const positions = reindent.matches.map(match => match.index + actualStart);
					throw (`Exact search failed, and automatic reindent found ${positions.length} matches at line(s) ${formatLineRanges(positions, countLines(search))}.
Add more unchanged context and/or correct indentation for "search" so it identifies one location.
No changes were written.`);
				}
				if (!reindent.matches.length) {
					let info = '';
					if (reindent.reason) {
						info += `\nAutomatic reindent failed because ${reindent.reason}`;
					}
					if (reindent.firstCandidates?.length) {
						info += `\nIndentation-insensitive candidate(s): ${formatLineRanges(reindent.firstCandidates, 1)}.`;
					}

					throw `"search" was not found in lines ${actualStart + 1}-${actualEnd}.${info}
No changes were written.`;
				}

				const match = reindent.matches[0];
				effectiveSearch = match.searchLines.join('\n');
				effectiveReplace = match.replaceLines.join('\n');
				lastIdx = content.indexOf(effectiveSearch);
			}

			const prefix = content.slice(0, lastIdx);
			newContent = prefix + effectiveReplace + content.slice(lastIdx + effectiveSearch.length);
			const prefixLines = actualStart + countLines(prefix);
			const replaceLines = countLines(effectiveReplace);
			const originalLines = countLines(effectiveSearch);
			msg += `
Changed lines: ${prefixLines}-${prefixLines + Math.max(0, replaceLines - 1)}`;
			delta = replaceLines - originalLines;
		}

		newContent = [
			lines.slice(0, actualStart).join("\n"),
			newContent,
			lines.slice(actualEnd).join("\n")
		].filter(Boolean).join("\n");

		const absPath = fs.absPath(path, ctx);
		await fs.write(absPath, newContent, ctx);
		cache.delete(absPath);

		return msg+`
Lines: ${lines.length} → ${lines.length + delta} (${delta > 0 ? '+': ''}${delta})`;
	};

	const write = async ({ path, content, overwrite }, ctx) => {
		const absPath = fs.absPath(path, ctx);
		check:
		if (!overwrite) {
			try {
				await fs.mtime(absPath, ctx);
			} catch {
				break check;
			}
			throw 'File already exist, fix name or read it.';
		}
		await fs.write(absPath, content, ctx);
		cache.set(absPath, content.split('\n'));
		return 'Success';
	};

	const del = filePath => cache.delete(filePath);

	const grep = async ({ pattern, path = ".", glob = "**", maxFiles = 50, maxMatchesPerFile = 10, context = 0 }, ctx) => {
		let flag = 'ug';
		const FETCH_PATTERN = /^\(\?([a-z]+)\)/;
		const exec = FETCH_PATTERN.exec(pattern);
		if (exec) {
			flag = exec[1];
			if (!/^[iusm]+$/.test(flag)) throw 'Unrecognized flag '+flag;
			flag += 'g';
			pattern = pattern.slice(flag.length+2);
		}
		const regExp = new RegExp(pattern, flag);

		let results = '';
		let matchedFiles = 0;

		const [enqueue, waitAll] = createAsyncQueue();

		let listError;
		let files;
		try {
			files = await fs.list({path, pattern: glob, json: true}, ctx);
			path += '/';
		} catch (e) {
			if (glob !== '**' && glob !== '*' && path !== glob && !path.endsWith("/"+glob)) throw e;
			listError = e;
			files = [["", 'file']];
		}

		for (const [relPath, type] of files) {
			if (type !== 'file') continue;
			if (matchedFiles >= maxFiles) break;

			await enqueue(async () => {
				if (matchedFiles >= maxFiles) return;

				let content;
				try {
					// TODO 这里可以缓存，但是可能搜索的文件多内存压力大
					content = await fs.read(fs.absPath(path + relPath, ctx), ctx);
				} catch {
					if (listError) throw listError;
					return;
				}

				if (matchedFiles >= maxFiles) return;
				const lines = content.split("\n");

				const matches = [];
				for (let i = 0; i < lines.length && matches.length < maxMatchesPerFile; i++) {
					regExp.lastIndex = 0;
					if (regExp.test(lines[i])) matches.push(i);
				}
				if (!matches.length) return;

				if (results) results += '\n';
				if (relPath) results += relPath+'\n';
				matchedFiles++;

				let prevI = 0;
				for (let i = 1; i <= matches.length; i++) {
					if (i < matches.length && matches[i] - matches[i-1] <= context * 2) continue;

					const start = Math.max(0, matches[prevI] - context);
					const end = Math.min(lines.length, matches[i-1] + context + 1);

					let matchIndex = prevI;
					for (let j = start; j < end; j++) {
						let line = lines[j];
						const isMatch = j === matches[matchIndex];
						if (isMatch) matchIndex++;

						if (line.length > GREP_MAX_COLUMNS) {
							line = line.slice(0, GREP_MAX_COLUMNS) + (isMatch
								? " [... "+[...line.matchAll(regExp)].filter((val) => val.index > GREP_MAX_COLUMNS).length+" more matches]"
								: " [... omitted end of long line]"
							);
						}
						results += (j+1) + (isMatch ? "\x1F" : "-") + line + '\n';
					}
					if (context) results += '---\n';
					prevI = i;
				}
			})
		}

		await waitAll();

		return results || '[No match]';
	};

	return { read, patch, edit, write, del, grep };
}