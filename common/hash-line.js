import {SHA256} from "unconscious/common/SHA256.js";

let crypto;
const isNode = !import.meta.env?.MODE;
if (isNode) {
	crypto = (await import('node:crypto')).default;
}

// ── Hash / anchor constants ──────────────────────────────────────
const HASHLINE_META_HEAD       = '[Metadata]\n';
const HASHLINE_META_SEP        = '[Raw content]\n';
const HASHLINE_META_SEP_ANCHOR = '[Content with anchors]\n';
const HASHLINE_LINE_SEP        = '#';
const HASHLINE_CONTENT_SEP     = '\t';

// ── Pure helpers ─────────────────────────────────────────────────
const shaHash = (content, len = 4) =>
	(isNode ? crypto.createHash('sha-256').update(content).digest('hex'): SHA256.hash(content)).slice(0, len);

const hashLine = (line, index) => `${index + 1}${HASHLINE_LINE_SEP}${shaHash(line)}`;

const parseHash = (hash, lines) => {
	hash = hash.toLowerCase();
	if (hash === HASHLINE_LINE_SEP + 'eof') return lines.length;
	const idx = hash.indexOf(HASHLINE_LINE_SEP);
	if (idx < 0 || hash.length !== 5 + idx)
		throw new Error('invalid anchor format, must be `line#hash`');

	const lineNo = parseInt(hash.slice(0, idx)) - 1;
	const line   = lines[lineNo];
	if (line && shaHash(line) === hash.slice(idx + 1)) return lineNo;

	let best = -1, bestDist = 50;
	let i = 0;
	for (;;) {
		i = lines.anchors.indexOf(hash, i);
		if (i < 0) break;
		const dist = Math.abs(i - lineNo);
		if (dist < bestDist) { best = i; bestDist = dist; }
		i += 1;
	}
	return best;
};


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
		const lines = str.split(/\r?\n/).map(item => item.trimEnd().replaceAll("\t", "  "));
		lines.anchors = lines.map(hashLine);
		lines.mtime = mtime;
		cache.set(path, new WeakRef(lines));
		return lines;
	};

	const read = async ({ path: filePath, start, end, max_chars = 32768, format = 'raw' }, ctx) => {
		const lines = await readLines(filePath, ctx);
		const first = start != null ? start - 1 : 0;
		const last  = end != null ? Math.min(end, lines.length) : lines.length;
		if (first < 0) throw new Error('Start line must > 0');
		if (first > lines.length) throw new Error("Start line > total lines ("+lines.length+"), no lines will be returned");
		if (first > last) throw new Error('Resolved end line is before start line');

		let limit = max_chars;
		let truncated = 0;
		const respLines = [];

		for (let i = first; i < last; i++) {
			const line = lines[i];
			if (limit < line.length) {
				truncated = `${last - i} lines before line#${i + 1} (length: ${line.length})`;
				break;
			}
			limit -= line.length;

			let text;
			switch (format) {
				case 'raw':     text = line; break;
				case 'anchors': text = lines.anchors[i] + HASHLINE_CONTENT_SEP + line; break;
				default:        text = (i + 1) + '\t' + line; break;
			}
			respLines.push(text);
		}

		let content = respLines.join('\n');
		if (truncated) content += `\n[TRUNCATED: ${respLines.length} of ${last - first} lines shown]`;
		return content;
	};

	const patch = async ({path: filePath, patches}, ctx) => {
		const lines = await readLines(filePath, ctx);
		const parsedPatches = [];

		for (let { start_anchor, end_anchor, lines: patchLines, content } of patches) {
			if (!patchLines) patchLines = content.split('\n');

			let start = parseHash(start_anchor, lines), end   = parseHash(end_anchor, lines);
			if (start < 0) throw (`Error locating anchor ${start_anchor}: The file may have changed significantly. Re-read to get fresh anchors.`);
			if (end < 0)   throw (`Error locating anchor ${end_anchor}: The file may have changed significantly. Re-read to get fresh anchors.`);
			if (start > end) throw ('Resolved end line is before start line: The file may have changed significantly. Re-read to get fresh anchors.');
			end++;
			parsedPatches.push({ start, end, patchLines });
		}

		parsedPatches.sort((a, b) => a.start - b.start);
		for (let i = 1; i < parsedPatches.length; i++) {
			const cur = parsedPatches[i];
			const prev = parsedPatches[i - 1];
			if (cur.start < prev.end)
				throw (`Patch ${i + 1} [${cur.start}, ${cur.end}] overlaps with patch ${i} [${prev.start}, ${prev.end}].`);
		}

		const newLines = [];
		const newAnchors = [];
		const push = (arr, offset) => {
			newLines.push(...arr);
			newAnchors.push(...arr.map((line, i) => hashLine(line, offset + i)));
		};

		let lastIndex = 0;
		let patchReport = '';

		for (let i = 0; i < parsedPatches.length; i++) {
			const { start, end, patchLines } = parsedPatches[i];
			push(lines.slice(lastIndex, start), lastIndex);
			const patchStart = newLines.length;
			push(patchLines, patchStart);

			const oldLen = end - start;
			const newLen = patchLines.length;
			const delta = newLen - oldLen;
			patchReport += (patchReport ? '\n' : '') +
				`[Patch ${i + 1}]\n` + //Range: [${start + 1}, ${end + 1})\nNew lines: ${newLen} (${delta > 0 ? '+' + delta : delta})\n
				HASHLINE_META_SEP_ANCHOR +
				patchLines.map((line, j) => newAnchors[patchStart + j] + HASHLINE_CONTENT_SEP + line).join('\n');

			lastIndex = end;
		}
		push(lines.slice(lastIndex), lastIndex);

		newLines.anchors = newAnchors;
		newLines.mtime = Date.now();
		cache.set(filePath, new WeakRef(newLines));
		await fs.write(filePath, newLines.join('\n'), ctx);

		return patchReport;
	};

	const replace = async ({ path, search, replace, all, start_line, end_line }, ctx) => {
		const lines = await readLines(path, ctx);
		const actualStart = (start_line ?? 1) - 1;
		const actualEnd = end_line ?? lines.length;
		const slice = lines.slice(actualStart, actualEnd);
		if (!slice.length) throw (`line slice [${start_line}, ${end_line}] is empty!`);
		const content = slice.join("\n");

		search = search.split("\n").map(item => item.trimEnd()).join("\n");
		replace = replace.split("\n").map(item => item.trimEnd()).join("\n");

		let newContent;
		if (all) {
			newContent = content.replaceAll(search, replace);
		} else {
			let count = 0, lastIdx = -1, idx = -1;
			while ((idx = content.indexOf(search, idx + 1)) !== -1) {
				count++;
				lastIdx = idx;
			}
			if (count === 0) throw (`'search' was not found in the file.`);
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
		return 'done';
	};

	const write = async ({ path, lines, content, return_anchors = false }, ctx) => {
		if (!lines) lines = content.split('\n');
		const data = content || lines.join('\n');
		await fs.write(path, data, ctx);

		const anchors = lines.map(hashLine);
		lines.anchors = anchors;
		cache.set(path, new WeakRef(lines));

		if (return_anchors) {
			return (
				HASHLINE_META_HEAD +
				'Lines: ' + lines.length + '\n' +
				HASHLINE_META_SEP_ANCHOR +
				lines.map((line, i) => anchors[i] + HASHLINE_CONTENT_SEP + line).join('\n')
			);
		}
		return 'done';
	};

	const del = filePath => cache.delete(filePath);

	return { read, patch, replace, write, del };
}