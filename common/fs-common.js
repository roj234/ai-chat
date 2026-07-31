/**
 *
 * @param {{
 *     read: (function(string, any): Promise<string>),
 *     write: (function(string, string, any): Promise<void>),
 *     mtime: (function(string, any): Promise<number>)
 * }} fs
 */
export function createTextFileEditHelper(fs) {
	const cache = new Map();  // filePath -> WeakRef<lines array>

	const readLines = async (path, ctx) => {
		let cached = cache.get(path)?.deref();
		const mtime = await fs.mtime(path, ctx);
		if (cached && mtime <= cached.mtime) return cached;

		const str = await fs.read(path, ctx);
		const lines = str.split(/\r?\n/);
		lines.mtime = mtime;
		cache.set(path, new WeakRef(lines));
		return lines;
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

		for (let i = 0; i < changes.length; i++) {
			const {search, replace} = changes[i];

			const searchLines = search.split('\n');
			const replaceLines = replace.split('\n');

			const n = searchLines.length;
			// 用首行在行数组里定位候选位置，再逐行验证后续行
			let matchIndex = -1;
			let j = 0;
			while (j + n <= lines.length) {
				const idx = lines.indexOf(searchLines[0], j);
				if (idx < 0) break;

				fail: {
					for (let k = 1; k < n; k++) {
						if (lines[idx + k] !== searchLines[k]) {
							break fail;
						}
					}

					if (matchIndex >= 0) throw `Hunk #${i + 1} occurred multiple times (Line ${matchIndex}-${matchIndex + n} and ${idx}-${idx + n}).`;
					matchIndex = idx;
				}

				j = idx + 1;
			}
			if (matchIndex < 0) throw `Hunk #${i + 1} could not be found.`;

			patches.push([ matchIndex, matchIndex + n, replaceLines ]);
		}

		patches.sort(([astart], [bstart]) => astart - bstart);
		for (let i = 1; i < patches.length; i++) {
			const [curStart, curEnd] = patches[i];
			const [prevStart, prevEnd] = patches[i - 1];
			if (curStart < prevEnd)
				throw (`Patch ${i + 1} [${curStart}, ${curEnd}] overlaps with edit ${i} [${prevStart}, ${prevEnd}].`);
		}

		const newLines = [];
		let lastIndex = 0;
		let msg = 'Success.';

		for (let i = 0; i < patches.length; i++) {
			const [ start, end, replaceLines ] = patches[i];
			newLines.push(...lines.slice(lastIndex, start));

			const startLine = newLines.length + 1;
			msg += `\nChanged lines: ${startLine}-${startLine + replaceLines.length}`

			newLines.push(...replaceLines);
			lastIndex = end;
		}
		newLines.push(...lines.slice(lastIndex))

		newLines.mtime = Date.now();
		await fs.write(path, newLines.join('\n'), ctx);
		cache.set(path, new WeakRef(newLines));

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
			if (lastIdx < 0) throw (`"search" was not found in the file.`);

			const prefix = content.slice(0, lastIdx);
			newContent = prefix + replace + content.slice(lastIdx + search.length).replaceAll(search, replace);
			delta = countLines(newContent) - countLines(content);
		} else {
			let count = 0, lastIdx = -1, idx = -1;
			while ((idx = content.indexOf(search, idx + 1)) !== -1) {
				count++;
				lastIdx = idx;
			}
			if (count === 0) {
				throw lines.join('\n').indexOf(search) >= 0 ? (`"search" exists but is not in the current range — use Grep to locate or just omit line numbers.`) : (`"search" was not found in the file.`);
			}
			if (count > 1) throw (`Found ${count} occurrences of the search string — the search must uniquely identify a single location. Please expand the 'search' to include more surrounding context.`);
			const prefix = content.slice(0, lastIdx);
			newContent = prefix + replace + content.slice(lastIdx + search.length);
			const prefixLines = 1 + actualStart + countLines(prefix);
			const replaceLines = countLines(replace);
			const originalLines = countLines(search);
			msg += `
Changed lines: ${prefixLines}-${prefixLines + replaceLines}`;
			delta = replaceLines - originalLines;
		}

		newContent = [
			lines.slice(0, actualStart).join("\n"),
			newContent,
			lines.slice(actualEnd).join("\n")
		].filter(Boolean).join("\n");

		await fs.write(path, newContent, ctx);
		cache.delete(path);

		return msg+`
Lines: ${lines.length} → ${lines.length + delta} (${delta > 0 ? '+': ''}${delta})`;
	};

	const write = async ({ path, content, overwrite }, ctx) => {
		check:
		if (!overwrite) {
			try {
				await fs.mtime(path, ctx);
			} catch {
				break check;
			}
			throw 'Error: File already exist';
		}
		await fs.write(path, content, ctx);
		cache.set(path, new WeakRef(content.split('\n')));
		return 'Success';
	};

	const del = filePath => cache.delete(filePath);

	return { read, patch, edit, write, del };
}