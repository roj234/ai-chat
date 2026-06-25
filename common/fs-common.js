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
		const lines = str.split(/\r?\n/).map(item => item.trimEnd());
		lines.mtime = mtime;
		cache.set(path, new WeakRef(lines));
		return lines;
	};

	const read = async ({ path, offset, limit, maxChars = 50000, format = 'raw' }, ctx) => {
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
			if (needWarning) content += `\nOVERFLOW(${needWarning}): Only ${last - first} lines available in requested range`;
		} else {
			content += 'EOF';
		}
		return content;
	};

	const patch = async ({path, edits}, ctx) => {
		const lines = await readLines(path, ctx);
		const patches = [];

		for (let { startLine, startContent, endLine, endContent, content } of edits) {
			const patchLines = content.split('\n');

			if (startLine > endLine) throw ('end before start.');
			if (lines[startLine-1] !== startContent) throw (`lines[startLine] !== startContent`);
			if (lines[endLine-1] !== endContent) throw (`lines[endLine] !== endContent`);

			patches.push([ startLine, endLine + 1, patchLines ]);
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
		let patchReport = 'success';

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

	const edit = async ({ path, search, replace, replaceAll, startLine, endLine }, ctx) => {
		if (search === replace) throw ('"search" cannot equals to "replace"');

		const lines = await readLines(path, ctx);
		const actualStart = (startLine ?? 1) - 1;
		const actualEnd = endLine ?? lines.length;
		const slice = lines.slice(actualStart, actualEnd);
		if (!slice.length) throw (`file slice [${startLine}, ${endLine}] is empty!`);
		const content = slice.join("\n");

		search = search.split("\n").map(item => item.trimEnd()).join("\n");
		replace = replace.split("\n").map(item => item.trimEnd()).join("\n");

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
			newContent = content.slice(0, lastIdx) + replace + content.slice(lastIdx + search.length);
		}

		newContent = [
			lines.slice(0, actualStart).join("\n"),
			newContent,
			lines.slice(actualEnd).join("\n")
		].filter(Boolean).join("\n");

		await fs.write(path, newContent, ctx);
		cache.delete(path);
		return 'success';
	};

	const write = async ({ path, lines, content }, ctx) => {
		if (!lines) lines = content.split('\n');
		const data = content || lines.join('\n');
		await fs.write(path, data, ctx);
		cache.set(path, new WeakRef(lines));
		return 'success';
	};

	const del = filePath => cache.delete(filePath);

	return { read, patch, edit, write, del };
}