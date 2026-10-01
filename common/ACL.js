import {FSE_AccessDenied, throwDOMException} from "./pure-utils.js";

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

	regexp += dirOnly ? '(/)?$' : '$';

	return [regexp, dirOnly];
};

export const READ = 1 << 0, WRITE = 1 << 1, LIST = 1 << 2;
const NO_READ = 1 << 3, NO_WRITE = 1 << 4, NO_LIST/* not really used */ = 1 << 5;
const IMPORTANT = 1 << 6, NO_MATCH = 1 << 7, NAME_ONLY = 1 << 8;

export class ACL {
	/** @type {Map<string, number>} */
	#acl = new Map();
	/** @type {number} 默认规则 */
	#defaultRule = READ | WRITE | LIST;

	#rules = [[],[],[],[]];

	constructor() {
		this.parseRule(`-wl /.trash/\n-wl .git/`);
	}

	/**
	 * 按行解析 ACL 语法正则: [!]?[+-][rwl]+ <pattern>
	 * 规则类型：
	 * # 注释
	 * 1. '*' -> 默认规则
	 * 2. '*.ext' -> 扩展名规则
	 * 3. 'name' -> 文件名规则
	 * 4. 'name/' -> 路径段落规则
	 * 5. '/test/' -> 路径前缀规则
	 * 6. '/test/*.jpg' -> 前缀扩展名规则
	 * 7. '/test/a.jpg' -> 文件前缀规则
	 */
	parseRule(s) {
		let lineNum = 0;
		const ERR = (exc, got) => {throwDOMException(`Malformed rule at line ${lineNum}, excepting ${exc} got ${got}`, 'SyntaxError')}

		for (let line of s.split('\n')) {
			lineNum++;
			line = line.trim();
			if (!line || line.startsWith('#')) continue;

			let i = 0;
			let flag = 0;
			let c = line[i++];
			if (c === '!') {
				flag = IMPORTANT;
				c = line[i++];
			}

			let noFlag = false;
			for (;;) {
				let shl;
				if (noFlag) ERR("FLAG", c);
				if (c === '+') shl = 0;
				else if (c === '-') shl = 3;
				else if (flag&(~IMPORTANT)) break;
				else ERR("ADD", c);

				noFlag = true;
				for (;;) {
					c = line[i++];
					if (c === 'r') flag |= 1 << shl;
					else if (c === 'w') flag |= 2 << shl;
					else if (c === 'l') flag |= 4 << shl;
					else break;

					noFlag = false;
				}
			}

			let path = line.slice(i).trim().toLowerCase();
			c = path[0];
			if (c == null) ERR("PATH", "EOF");

			if (c === '*') {
				if (path.length === 1) {
					if (flag&IMPORTANT) throwDOMException("IMPORTANT on defaultRule", "NotSupportedError");
					this.#defaultRule = flag;
					continue;
				}
			} else {
				if (c !== '/' && path.slice(0, -1).includes('/'))
					throwDOMException("Unsupported path: "+line, "NotSupportedError");
			}

			flag |= this.#acl.get(path);
			if ((flag >> 3) & flag & 7) throwDOMException("Rules conflict: "+line, "InvalidStateError");
			this.#acl.set(path, flag);
		}
	}

	/**
	 * @param {string} content
	 */
	parseIgnore(content) {
		for (let line of content.split('\n')) {
			line = line.trim();
			// Skip blanks and comments
			if (!line || line.startsWith('#')) continue;

			let negate = false;
			if (line.startsWith('!')) {
				negate = true;
				line = line.slice(1).trim();
			}

			// Skip escape backslash in patterns
			if (line.startsWith('\\')) line = line.slice(1);

			if (!line) continue;
			if (this.#addSimpleRule(line, negate)) continue;

			const [regexp, dirOnly] = compilePattern(line);
			this.#rules[dirOnly*1 + negate*2].push(regexp);
		}
	}

	#addSimpleRule(line, negate) {
		let pattern = line;
		let flag = negate ? LIST : NO_LIST;
		const apply = () => {
			const flag1 = flag | this.#acl.get(pattern);
			if ((flag1 >> 3) & flag1 & 7) throwDOMException("Rules conflict: "+line, "InvalidStateError");
			this.#acl.set(pattern, flag1);
		};

		if (pattern.startsWith('*.')) {
			// 暂时也不支持部分名称匹配
			if (/[.*?[\]/]/.test(pattern.slice(2))) return;
			apply();
			return true;
		}

		// 不允许通配符
		if (/[*?[\]]/.test(pattern)) return;
		// 不支持 a/b
		if (!pattern.startsWith('/') && pattern.includes('/')) return;
		if (pattern.endsWith('/') && !negate) flag |= NAME_ONLY;

		apply();

		if (!pattern.endsWith("/")) {
			pattern += "/";
			apply();
		}

		if (!negate) {
			pattern += '*';
			flag = LIST;
			apply();
		}

		return true;
	}

	compile() {
		this.#rules = this.#rules.map(item => item.length?new RegExp("(?:"+item.join(")|(?:")+")"):null);
	}

	/**
	 * @param {string[]} parts
	 * @param {boolean} isDir
	 * @returns {number}
	 */
	access(parts, isDir) {
		let flag = this.#defaultRule&(READ|WRITE);
		let listFlag = (this.#defaultRule&LIST) | NO_MATCH;
		let lockedBits = 0;

		/** @param {string} part */
		const apply = (part) => {
			const rule = this.#acl.get(part);
			if (!rule) return;

			// LIST 不继承
			if ((rule&(LIST|NO_LIST|NAME_ONLY)) && (rule&IMPORTANT) >= (listFlag&IMPORTANT))
				listFlag = rule & (LIST|NAME_ONLY|IMPORTANT);

			const bits = rule & (READ|WRITE|NO_READ|NO_WRITE);

			if (rule & IMPORTANT) lockedBits |= bits;
			else flag |= bits;

			flag &= ~(NO_READ | NO_WRITE | (flag >> 3));
			flag |= lockedBits;
			flag &= ~(NO_READ | NO_WRITE | (flag >> 3));
		};

		if (!parts.length) { apply('/'); return flag|listFlag; }

		let extensionName;
		const baseName = isDir ? '' : parts.at(-1).toLowerCase();
		if (baseName) {
			const dotIndex = baseName.lastIndexOf('.');
			if (dotIndex > 0) apply(extensionName = '*'+baseName.slice(dotIndex));
			apply(baseName);
		}

		let prefix = '/';
		const end = parts.length - !isDir;
		for (let i = 0; i < end; i++) {
			apply(prefix+'*');
			const part = parts[i].toLowerCase()+'/';
			apply(part);
			apply(prefix += part);
		}

		if (baseName) {
			apply(prefix+'*');
			if (extensionName) apply(prefix+extensionName);
			apply(prefix+baseName);
		}

		return flag|listFlag;
	}

	/**
	 * @param {string[]} parts
	 * @param {boolean} isDir
	 * @param {number} requiredFlag
	 * @returns {boolean}
	 */
	deny(parts, isDir, requiredFlag) {
		return (this.access(parts, isDir) & requiredFlag) !== requiredFlag;
	}

	/**
	 * @param {string[]} parts
	 * @param {boolean} isDir
	 * @param {number} requiredFlag
	 * @returns {void}
	 */
	denyThrow(parts, isDir, requiredFlag) {
		if (!isDir) requiredFlag &= ~LIST;
		const flags = this.access(parts, isDir) & requiredFlag;
		const missingBits = flags ^ requiredFlag;
		if (missingBits) throwDOMException(`Access denied for ${isDir?"directory":"file"} ${JSON.stringify(parts.join('/'))}`, FSE_AccessDenied);
	}

	/**
	 * 返回 'skip' 以跳过子项（仅对目录）
	 * @param {string} path
	 * @param {boolean} isDir
	 * @returns {boolean|'skip'}
	 */
	denyList(path, isDir) {
		const parts = path.split('/');
		const flag = this.access(parts, isDir);
		// 一个目录必须有 LIST 权限，才能在 Glob 中显示，必须有 READ 权限，才能递归列出子目录
		// 如果不具备 LIST 但有 NAME_ONLY 可以列出名字 (WIP)
		if ((flag&(LIST|READ|NAME_ONLY)) !== (LIST|READ)) {
			return flag&LIST && isDir ? (flag&READ) ? false : 'skip' : (flag&NAME_ONLY) ? 'skip' : true;
		}

		const [regexp, regexpDirOnly, regexpNegative, regexpDirOnlyNegative] = this.#rules;

		if (regexpNegative?.test(path)) return false;
		if (isDir && regexpDirOnlyNegative?.test(path)) return false;

		if (regexp?.test(path)) return true;
		// 旧版规则解析器兼容（并非完全兼容）
		if (isDir && regexpDirOnly?.test(path)) return 'skip';

		return false;
	}
}
