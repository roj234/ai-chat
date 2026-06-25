
/**
 * 转换gitignore模式为正则表达式
 * @param {string} pattern
 * @returns {[ regex: string, dirOnly: boolean ]}
 */
const compilePattern = pattern => {
	let dirOnly = false;

	// Trailing / → match directories only
	if (pattern.endsWith('/')) {
		dirOnly = true;
		pattern = pattern.slice(0, -1);
	}

	// Trailing /** means "everything inside this directory"
	if (pattern.endsWith('/**')) {
		dirOnly = true;
		pattern = pattern.slice(0, -3);
	}

	// Leading / anchors to the .gitignore file's directory
	// Also, any pattern containing / (not at start) is treated as anchored
	let anchored = pattern.includes('/');
	if (pattern.startsWith('/')) pattern = pattern.slice(1);

	let regexp = anchored ? '^' : '(^|.*/)';

	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];

		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				// **
				if (pattern[i + 2] === '/') {
					// **/ matches zero or more directories
					regexp += '(.*/)?';
					i += 3;
					continue;
				} else {
					// ** at end matches everything
					regexp += '.*';
					i += 2;
					continue;
				}
			}
			// * matches anything except /
			regexp += '[^/]*';
			i++;
		} else if (ch === '?') {
			regexp += '[^/]';
			i++;
		} else {
			// Escape regex meta-characters
			regexp += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			i++;
		}
	}

	regexp += dirOnly ? '(/.*)?$' : '$';

	return [regexp, dirOnly];
};

export class IgnoreMatcher {
	rules = [[],[],[],[]];

	/**
	 * @param {string} content
	 */
	parse(content) {
		for (let line of content.split('\n')) {
			line = line.trim();
			// Skip blanks and comments
			if (!line || line.startsWith('#')) continue;

			let negate = false;
			if (line.startsWith('!')) {
				negate = true;
				line = line.slice(1).trim();
				if (!line) continue;
			}

			// Skip escape backslash in patterns
			if (line.startsWith('\\')) {
				line = line.slice(1);
			}

			const [regexp, dirOnly] = compilePattern(line);
			this.rules[dirOnly*1 + negate*2].push(regexp);
		}
	}

	compile() {
		this.rules = this.rules.map(item => item.length?new RegExp("(?:"+item.join(")|(?:")+")"):null);
	}

	/**
	 *
	 * @param {string} relPath
	 * @param {boolean} isDir
	 * @returns {boolean}
	 */
	test(relPath, isDir) {
		if (relPath === '.git' || relPath.startsWith('.git/')) return true;

		const [regexp, regexpDirOnly, regexpNegative, regexpDirOnlyNegative] = this.rules;

		if (regexpNegative?.test(relPath)) return false;
		if (isDir && regexpDirOnlyNegative?.test(relPath)) return false;

		if (regexp?.test(relPath)) return true;
		if (isDir && regexpDirOnly?.test(relPath)) return true;

		return false;
	}
}
