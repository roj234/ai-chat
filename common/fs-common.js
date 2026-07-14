/**
 *
 * @param {{
 *     read: (function(string, any): Promise<string>),
 *     write: (function(string, string, any): Promise<void>),
 *     mtime: (function(string, any): Promise<number>)
 * }} fs
 */
export function createHashLine(fs) {
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

		for (let { startLine, startContent, endLine, endContent, content } of changes) {
			const patchLines = content.split('\n');

			if (startLine > endLine) throw ('end before start.');
			if (lines[startLine-1] !== startContent) throw (`lines[startLine] !== startContent`);
			if (lines[endLine-1] !== endContent) throw (`lines[endLine] !== endContent`);

			patches.push([ startLine, endLine, patchLines ]);
		}

		patches.sort(([astart], [bstart]) => astart - bstart);
		for (let i = 1; i < patches.length; i++) {
			const [curStart, curEnd] = patches[i];
			const [prevStart, prevEnd] = patches[i - 1];
			if (curStart < prevEnd)
				throw (`Edit ${i + 1} [${curStart}, ${curEnd}] overlaps with edit ${i} [${prevStart}, ${prevEnd}].`);
		}

		const newLines = [];
		let lastIndex = 0;
		let patchReport = 'Success';

		for (let i = 0; i < patches.length; i++) {
			const [ start, end, patchLines ] = patches[i];
			newLines.push(...lines.slice(lastIndex, start-1));
			newLines.push(...patchLines);
			lastIndex = end;
		}
		newLines.push(...lines.slice(lastIndex))

		newLines.mtime = Date.now();
		await fs.write(path, newLines.join('\n'), ctx);
		cache.set(path, new WeakRef(newLines));
		return patchReport;
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

		search = search.split("\n").join("\n");
		replace = replace.split("\n").join("\n");

		let prefixLines, replaceLines, originalLines;

		let newContent;
		if (replaceAll) {
			newContent = content.replaceAll(search, replace);
		} else {
			let count = 0, lastIdx = -1, idx = -1;
			while ((idx = content.indexOf(search, idx + 1)) !== -1) {
				count++;
				lastIdx = idx;
			}
			if (count === 0) throw (`"search" was not found in the file.`);
			if (count > 1) throw (`Found ${count} occurrences of the search string — the search must uniquely identify a single location. Please expand the 'search' to include more surrounding context.`);
			const prefix = content.slice(0, lastIdx);
			newContent = prefix + replace + content.slice(lastIdx + search.length);
			prefixLines = actualStart + countLines(prefix);
			replaceLines = countLines(replace);
			originalLines = countLines(search);
		}

		newContent = [
			lines.slice(0, actualStart).join("\n"),
			newContent,
			lines.slice(actualEnd).join("\n")
		].filter(Boolean).join("\n");

		await fs.write(path, newContent, ctx);
		cache.delete(path);

		const delta = replaceLines - originalLines;
		return `Success.
Changed lines (new file): ${prefixLines}-${prefixLines + replaceLines}
Lines: ${lines.length} → ${lines.length + delta} (${delta > 0 ? '+': ''}${delta})`;
	};

	const write = async ({ path, content, overwrite }, ctx) => {
		if (!overwrite) {
			try {
				await fs.mtime(path, ctx);
				throw 'Error: File already exist';
			} catch {}
		}
		await fs.write(path, content, ctx);
		cache.set(path, new WeakRef(content.split('\n')));
		return 'Success';
	};

	const del = filePath => cache.delete(filePath);

	return { read, patch, edit, write, del };
}