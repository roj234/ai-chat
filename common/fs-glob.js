import {normalizePath} from "unconscious/common/path-utils.js";

export const globMacroPlugin = () => {
	return {
		name: 'glob-template-helper',
		/**
		 *
		 * @param {string} code
		 * @param {string} id
		 * @return {Promise<{code: string, map: null}>}
		 */
		async transform(code, id) {
			if (!id.endsWith('WebFSDriver.js') && !id.endsWith("agent.js")) return;

			code = code.replace(/return eval\(generateGlobCode\((true|false)\)\);/, (_, m) => generateGlobCode(m === "true", true));
			return { code, map: null };
		}
	};
}

// ────────────────────────────── Glob -> NFA ──────────────────────────────

const REGEX_META_CHARS = new Set('.^$+{}[]|()');
const GLOB_META_CHARS = new Set('\\*?[{');
const EOF = undefined;

// NFA node kinds
const MATCH = 0, DESCENTS = 1, GROUP = 2;
const ACCEPT_BIT = 1;
const GLOBSTAR = { t: DESCENTS };
const M = regex => ({t: MATCH, re: regex});

/**
 * @param {string} glob
 * @param {boolean} [reOnly] 展开为匹配整段路径的正则（用于 negate）
 * @return {(AiChat.GlobSegment[] & { _eps?: true }) | string}
 */
export function parseGlobPattern(glob, reOnly) {
	const items = [];
	let regex = '';
	let i = 0;
	let hasEps = false;

	const flush = () => {
		if (regex) {
			if (regex === '.*') {
				if (items.at(-1) !== GLOBSTAR)
					items.push(GLOBSTAR);
			} else {
				items.push(M(regex));
			}
			regex = '';
		}
	};

	while (i < glob.length) {
		let c = glob[i++];
		switch (c) {
			case '\\': {
				if (i === glob.length)
					throw new Error(`No character to escape at position ${i - 1}`);
				const nextChar = glob[i++];
				if (GLOB_META_CHARS.has(nextChar) || REGEX_META_CHARS.has(nextChar)) regex += ('\\');
				regex += (nextChar);
				break;
			}
			case '/': {
				flush();
				break;
			}
			case '[': {
				regex += ('[');
				if (glob[i] === '^') {
					regex += ('\\^');
					i++;
				} else {
					if (glob[i] === '!') {
						regex += ('^');
						i++;
					}
					if (glob[i] === '-') {
						regex += ('-');
						i++;
					}
				}
				let hasRangeStart = false;
				let last = 0;
				while (i < glob.length) {
					c = glob[i++];
					if (c === ']') break;
					if (c === '/') throw new Error(`Explicit 'name separator' in class at ${i - 1}`);
					if (c === '\\' || c === '[') regex += ('\\');
					regex += (c);
					if (c === '-') {
						if (!hasRangeStart) throw new Error(`Invalid range at ${i - 1}`);
						c = glob[i];
						if (c === EOF) break;
						if (c === ']') { i++; break; }
						if (c < last) throw new Error(`Invalid range at ${i - 3}`);
						if (c === '\\' || c === '[') regex += ('\\');
						regex += (c);
						i++;
						hasRangeStart = false;
					} else {
						hasRangeStart = true;
						last = c;
					}
				}
				if (c !== ']') throw new Error('Missing \']\'');
				regex += (']');
				break;
			}
			case '{': {
				const val = matchGroup(glob, i);
				if (val == null) throw new Error(`Missing '}' at ${i - 1}`);

				i = val[1] + 1;
				const branches = val[0].map(item => parseGlobPattern(item, reOnly));

				if (reOnly || branches.every(branch => branch.length === 1 && branch[0].t === MATCH)) {
					regex += '(?:(?:' + (reOnly ? branches : branches.map(branch => branch[0].re)).join(')|(?:') + '))';
				} else {
					if (regex) {
						for (const item of branches) {
							const t = item[0];
							if (t.t === MATCH) {
								t.re = regex + t.re;
							} else {
								item.unshift(M(regex));
							}
						}
						regex = '';
					}
					items.push({ t: GROUP, branches });
					hasEps = true;
				}
				break;
			}
			case '*': {
				if (glob[i] === '*') {
					regex += ('.*');
					i++;
				} else {
					regex += ('[^/]*');
				}
				break;
			}
			case '?': {
				regex += ('[^/]');
				break;
			}
			default: {
				if (REGEX_META_CHARS.has(c)) regex += ('\\');
				regex += (c);
				break;
			}
		}
	}

	flush();

	if (reOnly) return items.map(s => s.t === MATCH ? s.re : '.*').join('/');

	if (hasEps) items._eps = true;
	return items;
}

/**
 * @param {string} str
 * @param {number} open
 * @return {[string[], number]}
 */
function matchGroup(str, open) {
	let depth = 1;
	let inClass = false;
	let parts = [];
	let prevIndex = open;

	for (let i = prevIndex; i < str.length; i++) {
		const c = str[i];
		if (c === '\\') { i++; }
		else if (inClass) {
			if (c === ']') inClass = false;
		}
		else if (c === '[') { inClass = true; }
		else if (c === ',' && depth === 1) {
			parts.push(str.slice(prevIndex, i));
			prevIndex = i+1;
		}
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) {
			parts.push(str.slice(prevIndex, i));
			return [parts, i];
		}
	}
}

/**
 * @param {AiChat.GlobSegment[]} items
 */
function compileNFA(items) {
	const kind = [,];
	const re = [,];
	const out = [,];

	const add = (k, r, o) => {
		kind.push(k);
		re.push(r);
		return out.push(o) - 1;
	};

	const toNFA = (list, cont) => {
		let cur = cont;
		for (let i = list.length - 1; i >= 0; i--) {
			const it = list[i];
			if (it.t === DESCENTS) cur = add(DESCENTS, null, [cur]);
			else if (it.t === MATCH) cur = add(MATCH, new RegExp('^'+it.re+'$', 'iu'), [cur]);
			else cur = add(GROUP, null, it.branches.map(branch => toNFA(branch, cur)));
		}
		return cur;
	};

	const start = toNFA(items, 0);

	const N = kind.length;
	if (N > 32) throw new Error(`Glob pattern too complex`);

	const masks = new Uint32Array(N);
	// 注意后面所有 n 都是 1 开始，因为 bit 0 = ACCEPT_BIT
	for (let n = 0; n < N; n++) masks[n] = 1 << n;

	// 出边总是指向更早创建的节点，因此按 id 升序一次即可完成传递闭包。
	for (let n = 1; n < N; n++) {
		const k = kind[n];
		if (k !== DESCENTS && k !== GROUP) continue;

		let m = 1 << n;
		for (const s of out[n]) m |= masks[s];
		masks[n] = m;
	}

	// non-trivial states
	let carry = 0, suffix = 0;
	for (let n = 1; n < N; n++) {
		if (kind[n] === DESCENTS) {
			carry |= 1 << n;
			const next = out[n][0];

			// o ⊕ n -> DESCENTS
			if (((suffix >> next) & 1) || (masks[next] & ACCEPT_BIT))
				suffix |= 1 << n;
		}
	}

	const startEps = masks[start];

	// (match & carry) = 0 恒成立，所以两个 next 表可以复用内存
	let match = 0;
	for (let n = N - 1; n > 0; n--) {
		if (kind[n] === MATCH) {
			match |= 1 << n;
			masks[n] = masks[out[n][0]];
		}
	}

	return {
		re,
		masks,
		start: startEps, match, carry, suffix,
	};
}

const LITERAL_PREFIX = /^(?:\.?\/)?((?:[^*?\[{\\\/]+\/)+)/;

/**
 * @param {string} pattern 正模式
 * @param {string} path 工作目录
 * @param {string[]} [exclude] 反模式
 * @return {{
 *     path: string,
 *     prefix: string,
 *     negate?: RegExp,
 *     segments?: (RegExp | null)[],
 *     nfa?: AiChat.GlobNFA
 * }}
 */
export function compileGlobPattern(pattern, path, exclude) {
	let prefix = '';

	const match = pattern.match(LITERAL_PREFIX);
	if (match) {
		prefix = match[1];
		path += '/'+prefix;
		pattern = pattern.slice(match[0].length);
	}
	path = normalizePath(path).join('/');

	const nodes = parseGlobPattern(pattern);
	const obj = { path, prefix };

	if (nodes._eps) {
		obj.nfa = compileNFA(nodes);
	} else {
		obj.segments = nodes.map(item => item.re && new RegExp('^'+item.re+'$', 'iu'));
	}

	if (exclude?.length) {
		obj.exclude = new RegExp('(?:^|/)'+parseGlobPattern(exclude.length > 1 ? '{'+exclude.join(",")+'}' : exclude[0], true)+'$', 'iu');
	}

	return obj;
}

// ────────────────────────── Code generation ──────────────────────────

export async function* emptyAsyncGenerator() {}

export const generateGlobCode = (remote, callByBuildPlugin) => {
	let iter = remote ? `for (const h of await fs.readdir(dirHandle, { withFileTypes: true })) {
	const name = h.name;
` : `for await (const [name, h] of dirHandle) {
`;
	const h = remote ? 'path.join(h.parentPath, h.name)' : 'h';
	const isDir = remote ? 'h.isDirectory()' : "h.kind === 'directory'";
	const yiel = remote ? 'h' : '[name, h, relPath.slice(prefixLength)]';

	iter += `\nif (name[0] === '.' && !showHidden) continue;`;

	return `
	let prefix = result.path;
	let prefixLength = prefix.length - result.prefix.length;
	if (prefixLength) prefixLength++;
	const queue = mpscScheduler(20, 100);

	async function yieldDescendants(dirHandle, relPath) {
		${iter}
			const absPath = relPath ? relPath + '/' + name : name;
			if (excl?.test(absPath.slice(prefixLength))) continue;

			const isDir = ${isDir};

			const ignore = acl.denyList(absPath, isDir);
			if (ignore) {
				if (ignore === 'skip') await queue.push(${yiel});
				continue;
			}

			await queue.push(${yiel});
			if (isDir) await queue.submit(() => yieldDescendants(${h}, absPath));
		}
	}

	const {segments, exclude: excl} = result;
	
	if (segments) {
		const walk = async (dirHandle, relPath, segIdx) => {
			const seg = segments[segIdx];
			let nextIdx = segIdx + 1;
			let isLast = nextIdx >= segments.length;

			// DESCENTS
			if (seg == null) {
				if (isLast) { return yieldDescendants(dirHandle, relPath); }
	
				await queue.submit(() => walk(dirHandle, relPath, nextIdx));
				${iter}
					const absPath = relPath ? relPath + '/' + name : name;
					if (${isDir} && !acl.denyList(absPath, true)) {
						await queue.submit(() => walk(${h}, absPath, segIdx));
					}
				}
				return;
			}
	
			${iter}
				if (!seg.test(name)) continue;
				const absPath = relPath ? relPath + '/' + name : name;
				if (excl?.test(absPath.slice(prefixLength))) continue;

				const isDir = ${isDir};
	
				if (isLast) {
					if (true !== acl.denyList(absPath, isDir)) {
						await queue.push(${yiel});
					}
				} else if (isDir && !acl.denyList(absPath, true)) {
					await queue.submit(() => walk(${h}, absPath, nextIdx));
				}
			}
		};

		queue.submit(() => walk(handle, prefix, 0));
	} else {
		const {re, masks, start, match, carry, suffix} = result.nfa;

		const walk = async (dirHandle, relPath, mask) => {
			if (mask & suffix) return yieldDescendants(dirHandle, relPath);

			${iter}
				const isDir = ${isDir};
				let childMask = 0;

				for (let m = mask & match, n; m; m ^= 1 << n) {
					n = 31 - Math.clz32(m);
					const nx = masks[n];

					if ((nx === ${ACCEPT_BIT} || isDir) && re[n].test(name))
						childMask |= nx;
				}

				if (isDir) {
					for (let m = mask & carry, n; m; m ^= 1 << n) {
						n = 31 - Math.clz32(m);
						childMask |= masks[n];
					}
				}

				if (!childMask) continue;

				const absPath = relPath ? relPath + '/' + name : name;
				if (exclude?.test(absPath.slice(prefixLength))) continue;

				const denyState = acl.denyList(absPath, isDir);
	
				// Self
				if ((childMask & ${ACCEPT_BIT}) && true !== denyState) await queue.push(${yiel});

				// Descents
				if ((childMask & ~${ACCEPT_BIT}) && !denyState)
					await queue.submit(() => walk(${h}, absPath, childMask));
			}
		};

		queue.submit(() => walk(handle, prefix, result.start));
	}

	${callByBuildPlugin ? 'return' : ''} queue.drain();`
};
