/**
 * Tree-sitter parsing engine — single-pass extraction of code graph.
 *
 * Architecture:
 *   parseSource(source, filePath, baseDir, config) → { nodes, edges }
 *   No duplicated code. Both parseFile and buildGraph share the same function.
 */

import fs from 'node:fs';
import path from 'node:path';
import {Language, Parser} from 'web-tree-sitter';
import {LANGUAGES, SUPPORTED_EXTENSIONS} from './languages.js';
import {readdir, readFile} from 'node:fs/promises';

const languageInstances = new Map();
const parserInstances = new Map();

/**
 * @param {string} wasmArchive
 */
export async function loadParsers(wasmArchive) {
	if (parserInstances.size) return;
	parserInstances.set(null, 1);

	await Parser.init();

	const archive = await globalThis.AiChatAPI.ZipReader(await fs.promises.readFile(wasmArchive));

	for (const [name, cfg] of Object.entries(LANGUAGES)) {
		const wasmData = await archive.get("tree-sitter-"+(cfg.wasmName||name)+".wasm");
		if (wasmData) {
			const lang = await Language.load(wasmData);
			languageInstances.set(name, lang);

			const p = new Parser();
			p.setLanguage(lang);
			parserInstances.set(name, p);
		}
	}

	parserInstances.delete(null);
}

export const availableLanguages = () => [...parserInstances.keys()];

const NodeKind = {
	FILE: 'File',
	FUNCTION: 'Function',
	CLASS: 'Class',
	VARIABLE: 'Variable',
	TEST: 'Test',
};

const EdgeKind = {
	CALLS: 'CALLS',
	IMPORTS: 'IMPORTS',
	INHERITS: 'INHERITS',
	CONTAINS: 'CONTAINS',
	REFERENCES: 'REFERENCES',
};

const readText = (node, src) => src.slice(node.startIndex, node.endIndex);

/**
 * @param {import('web-tree-sitter').SyntaxNode} node
 * @param {string} fieldName
 */
const findChild = (node, fieldName) => node.childForFieldName?.(fieldName);

/**
 * @param {import('web-tree-sitter').SyntaxNode} node
 * @param {string[]} types
 */
const findChildIn = (node, types) => {
	for (const c of node.namedChildren)
		if (types.includes(c.type))
			return c;
	return null;
};

const extractName = (node, cfg, code) => {
	const name = findChildIn(node, cfg.nameField);
	return name ? readText(name, code) : '<anonymous>';
};

const modifierTypes = new Set(['async', 'static', 'export', 'abstract', 'virtual', 'override', 'public', 'private', 'protected', 'internal', 'readonly', 'const']);
const extractModifiers = node => node.children.filter(c => modifierTypes.has(c.type)).map(c => c.type);

/** @typedef {{
 * kind: string,
 * name: string,
 * qname: string,
 * parent?: string,
 * file: string,
 * lineStart: number,
 * lineEnd: number,
 * signature?: string,
 * modifiers?: string,
 * exported?: boolean,
 * }} Node
 */

/** @typedef {{
 * kind: string,
 * source: string,
 * target: string,
 * file: string,
 * line: number,
 * }} Edge
 */

/**
 * Recursively walk AST to find nodes / edges
 *
 * @param {string} relPath
 * @param {string} code — source code text
 * @param {import('web-tree-sitter').SyntaxNode} root
 * @param {import('./languages.js').LanguageConfig} cfg
 * @param {Node[]} nodes
 * @param {Edge[]} edges
 */
function walkAST(relPath, code, root, cfg, nodes, edges) {
	nodes.push({
		kind: NodeKind.FILE,
		name: path.basename(relPath),
		qname: relPath,
		file: relPath,
		lineStart: root.startPosition.row + 1,
		lineEnd: root.endPosition.row + 1,
	});

	const commentTypes = new Set(cfg.commentTypes || []);

	const seen = new Set([relPath]);
	const calls = (source, target, line) => {
		edges.push({
			kind: EdgeKind.CALLS,
			source,
			target,
			file: relPath,
			line
		});
	};

	/**
	 * @param {import('web-tree-sitter').SyntaxNode} node
	 * @param {string[]} nameList
	 * */
	function walk(node, nameList) {
		const t = node.type;
		if (commentTypes.has(t)) return;

		const parentQn = nameList.join("::");

		// ── Class ──
		if (cfg.classTypes.includes(t)) {
			const name = extractName(node, cfg, code);

			const qn = nameList.join("::")+"::"+name;
			if (!seen.has(qn)) {
				seen.add(qn);

				const modifiers = extractModifiers(node, code);
				const isExported = node.parent?.type === 'export_statement';

				nodes.push({
					kind: NodeKind.CLASS,
					name,
					qname: qn,
					file: relPath,
					lineStart: node.startPosition.row + 1,
					lineEnd: node.endPosition.row + 1,
					modifiers: modifiers.length ? JSON.stringify(modifiers) : null,
					exported: isExported,
				});
				edges.push({
					kind: EdgeKind.CONTAINS,
					source: parentQn,
					target: qn,
					file: relPath,
					line: node.startPosition.row + 1,
				});

				// Inheritance
				if (cfg.inheritsTypes?.length) {
					const inh = findChildIn(node, cfg.inheritsTypes);
					if (inh) for (const c of inh.namedChildren) {
						const base = readText(c, code).replace(/^(extends|implements)\s*/, '');
						if (base && base !== name) edges.push({
							kind: EdgeKind.INHERITS,
							source: qn,
							target: base,
							file: relPath,
							line: c.startPosition.row + 1,
						});
					}
				}
			}

			// Recurse into body
			const body = findChildIn(node, cfg.bodyField);
			if (body) {
				nameList.push(name);
				for (const c of body.namedChildren)
					walk(c, nameList);
				nameList.pop();
			}

			return;
		}

		// ── Function ──
		if (cfg.functionTypes.includes(t)) {
			if (t === 'decorated_definition') {
				node = node.namedChildren.find(c => cfg.functionTypes.includes(c.type));
				if (!node) return;
			}

			const name = extractName(node, cfg, code);
			const qn = nameList.join("::")+"::"+name;

			if (!seen.has(qn)) {
				const mods = extractModifiers(node, code);
				const paramsNode = findChild(node, 'parameters');
				const retNode = findChild(node, 'return_type') || findChild(node, 'returns');
				const sig = [paramsNode && readText(paramsNode, code), retNode && readText(retNode, code)].filter(Boolean).join(': ') || null;
				const isExported = node.parent?.type === 'export_statement';

				seen.add(qn);

				nodes.push({
					kind: NodeKind.FUNCTION,
					name: /*cfg.functionLabelParens !== false ? `${name}()` : */name,
					qname: qn,
					file: relPath,
					lineStart: node.startPosition.row + 1,
					lineEnd: node.endPosition.row + 1,
					parent: parentQn === relPath ? null : parentQn,
					signature: sig,
					modifiers: mods.length ? mods.join(' ') : null,
					exported: isExported,
				});
				edges.push({
					kind: EdgeKind.CONTAINS,
					source: parentQn,
					target: qn,
					file: relPath,
					line: node.startPosition.row + 1
				});

				const body = findChildIn(node, cfg.bodyField);
				if (body) walkFunctionBody(body, qn);
			}

			return;
		}

		// ── Import ──
		if (cfg.importTypes.includes(t)) {
			/** @param {import('web-tree-sitter').SyntaxNode} n */
			const collectSpecifiers = n => {
				for (const c of n.namedChildren) {
					const ct = c.type;
					if (ct === 'string' || ct === 'string_literal' || ct === 'string_fragment' || ct === 'system_lib_string') {
						const imp = readText(c, code).replace(/^['"]|['"]$/g, '');
						edges.push({
							kind: EdgeKind.IMPORTS,
							source: relPath,
							target: imp,
							file: relPath,
							line: node.startPosition.row + 1
						});
					}
					if (ct === 'import_specifier' || ct === 'import_spec' || ct === 'namespace_import') {
						const nameNode = c.childForFieldName?.('name') || c.firstNamedChild;
						if (nameNode) edges.push({
							kind: EdgeKind.IMPORTS,
							source: relPath,
							target: readText(nameNode, code),
							file: relPath,
							line: node.startPosition.row + 1
						});
					}
					// Recurse into import_clause / named_imports wrappers
					if (ct === 'import_clause' || ct === 'named_imports') {
						collectSpecifiers(c);
					}
				}
			};
			collectSpecifiers(node);
			return;
		}

		// ── Preprocessor include ──
		if (t === 'preproc_include') {
			for (const c of node.namedChildren) {
				if (c.type === 'string_literal' || c.type === 'system_lib_string') {
					edges.push({
						kind: EdgeKind.IMPORTS,
						source: relPath,
						target: readText(c, code).replace(/^['"<]|['">]$/g, ''),
						file: relPath,
						line: node.startPosition.row + 1
					});
				}
			}
			return;
		}

		// ── Variable (module-level only) ──
		if (cfg.variableTypes?.includes(t)) {
			const isExported = node.parent?.type === 'export_statement';
			for (const c of node.namedChildren) {
				if (c.type === 'variable_declarator' || c.type === 'identifier' || c.type === 'property_identifier') {
					let name = readText(c, code);
					const idx = /\s/.exec(name);
					idx && (name = name.slice(0, idx.index));

					const qn = nameList.join("::")+"::"+name;
					if (!seen.has(qn)) {
						seen.add(qn);
						nodes.push({
							kind: NodeKind.VARIABLE,
							name: name,
							qname: qn,
							file: relPath,
							lineStart: c.startPosition.row + 1,
							lineEnd: c.endPosition.row + 1,
							parent: parentQn === relPath ? null : parentQn,
							exported: isExported,
						});
					}
					// If the value is a function expression, scan its body for calls
					const val = c.childForFieldName?.('value');
					if (val && cfg.functionTypes.includes(val.type)) {
						const body = findChildIn(val, cfg.bodyField);
						if (body) walkFunctionBody(body, qn);
					}
				}
			}
			return;
		}

		// ── CSS rule ──
		if (t === 'rule_set' && cfg.name === 'CSS') {
			const sel = findChildIn(node, ['selectors', 'class_name', 'id_name', 'tag_name']);
			if (sel) {
				const name = readText(sel, code);
				const qn = nameList.join("::")+"::"+name;
				if (!seen.has(qn)) {
					seen.add(qn);
					nodes.push({
						kind: NodeKind.CLASS,
						name: name,
						qname: qn,
						file: relPath,
						lineStart: node.startPosition.row + 1,
						lineEnd: node.endPosition.row + 1,
						parent: parentQn === relPath ? null : parentQn,
					});
				}
			}
			return;
		}

		// ── HTML elements ──
		if ((t === 'element' || t === 'script_element' || t === 'style_element') && cfg.name === 'HTML') {
			const tagNode = findChildIn(node, ['tag_name', 'start_tag']);
			if (tagNode) {
				const name = readText(tagNode, code).replace(/^<|>$/g, '');
				const qn = nameList.join("::")+"::"+name;
				if (!seen.has(qn)) {
					seen.add(qn);
					nodes.push({
						kind: NodeKind.CLASS,
						name: `<${name}>`,
						qname: qn,
						file: relPath,
						lineStart: node.startPosition.row + 1,
						lineEnd: node.endPosition.row + 1,
						parent: parentQn === relPath ? null : parentQn,
					});
				}
			}
			return;
		}

		// ── Recurse ──
		for (const c of node.namedChildren) walk(c, nameList);
	}

	/**
	 * @param {import('web-tree-sitter').SyntaxNode} node
	 * @param {string} parentQn
	 */
	function walkFunctionBody(node, parentQn) {
		const t = node.type;
		if (commentTypes.has(t)) return;

		if (cfg.callTypes.includes(t)) {
			let callee = null;
			const fn = findChild(node, cfg.callFunctionField);
			if (fn) callee = readText(fn, code);
			else {
				const f = node.firstNamedChild;
				if (f) callee = readText(f, code);
			}
			if (callee) calls(parentQn, callee, node.startPosition.row + 1);
		} else if (cfg.callAccessorTypes.includes(t)) {
			const p = node.parent;
			if (p && cfg.callTypes.includes(p.type)) {
				const methodField = findChild(node, cfg.callAccessorField);
				const objField = cfg.callAccessorObjectField ? findChild(node, cfg.callAccessorObjectField) : null;
				const method = methodField ? readText(methodField, code) : null;
				const obj = objField ? readText(objField, code) : null;
				if (method) calls(
					parentQn,
					obj ? `${obj}.${method}` : method,
					p.startPosition.row + 1
				);
				return;
			}
		}

		for (const c of node.namedChildren) walkFunctionBody(c, parentQn);
	}

	const nameList = [relPath];
	for (const c of root.namedChildren) walk(c, nameList);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a directory and extract graph for all supported files.
 * @param {string} dir   — absolute directory path
 * @param {string} baseDir   — workspace root for relative paths
 * @param {object} [opts]
 * @param {string[]} [opts.includeFiles]
 * @param {string} [opts.ignore]
 * @param {number} [opts.since]
 * @returns {Promise<{ files: string[], changedFiles: string[], nodes: Node[], edges: Edge[], errors: string[] }>}
 */
export async function buildGraph(dir, baseDir, opts = {}) {
	let {
		includeFiles = null,
		ignore = null,
		since = 0,
	} = opts;
	const onlyFilesSet = includeFiles ? new Set(includeFiles) : null;

	if (!ignore) try {
		ignore = await readFile(path.join(dir, '.ignore'), 'utf-8');
	} catch {}
	if (!ignore) try {
		ignore = await readFile(path.join(dir, '.gitignore'), 'utf-8');
	} catch {}

	let ignoreMatcher;
	if (ignore) {
		ignoreMatcher = new globalThis.AiChatAPI.IgnoreMatcher();
		ignoreMatcher.parse(ignore);
		ignoreMatcher.compile();
	}

	const prefixLength = baseDir.length+1;
	const nodes = [], edges = [], errors = [], files = [], changedFiles = [];

	/**
	 * 递归遍历子目录
	 * @param {string} dir - 当前扫描的绝对路径
	 */
	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = fullPath.slice(prefixLength).replaceAll("\\", "/");

			// .ignore rules
			if (ignoreMatcher?.test(relativePath, entry.isDirectory())) continue;

			// Default skips
			if (entry.name.startsWith('.')) continue;

			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();

				const langKey = SUPPORTED_EXTENSIONS.get(ext.slice(1));
				const cfg = LANGUAGES[langKey];
				const parser = parserInstances.get(langKey);
				if (!parser) continue;

				files.push(relativePath);

				if (onlyFilesSet && !onlyFilesSet.has(relativePath)) continue;

				// mtime check — skip unchanged files
				if (since > 0) {
					let stat;
					try { stat = await fs.promises.stat(fullPath); } catch { continue; }
					if (stat.mtimeMs <= since) continue;
				}

				changedFiles.push(relativePath);

				// TODO guess encoding
				const source = await readFile(fullPath, 'utf-8');

				try {
					const tree = parser.parse(source);
					const root = tree.rootNode;
					walkAST(relativePath, source, root, cfg, nodes, edges);
				} catch (er) {
					errors.push(`${relativePath}: ${er.message}`);
				}
			}
			// 符号链接、socket 等其他类型自动忽略
		}
	}

	await walk(dir);

	// By LLM
	(function resolveImports() {
		// Build export map: file -> {name -> qname}
		const exportsByFile = new Map();
		for (const node of nodes) {
			if (!node.exported) continue;
			let map = exportsByFile.get(node.file);
			if (!map) { map = new Map(); exportsByFile.set(node.file, map); }
			if (!map.has(node.name)) map.set(node.name, node.qname);
		}

		// Group imports by source file
		const importGroups = new Map();
		for (let i = 0; i < edges.length; i++) {
			const e = edges[i];
			if (e.kind !== 'IMPORTS') continue;
			const src = e.source;
			let group = importGroups.get(src);
			if (!group) { group = { moduleEdges: [], nameEdges: [] }; importGroups.set(src, group); }
			if (e.target.startsWith('.') || e.target.startsWith('/')) {
				group.moduleEdges.push({ idx: i, path: e.target });
			} else {
				group.nameEdges.push({ idx: i, name: e.target });
			}
		}

		// Resolve: map module paths to files, then map bare names to qnames
		for (const [srcFile, group] of importGroups) {
			if (!group.nameEdges.length) continue;

			const candidates = new Set();
			for (const { path: impPath, idx } of group.moduleEdges) {
				let resolved;
				if (impPath.startsWith('.')) {
					resolved = path.posix.normalize(path.posix.join(path.posix.dirname(srcFile), impPath));
				} else if (impPath.startsWith('/')) {
					resolved = impPath.slice(1);
					edges[idx].target = resolved;
				}
				if (resolved) {
					candidates.add(resolved);
					// Try common extensions and /index files for extension-less imports
					const tryExts = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
						'/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
					for (const ext of tryExts) {
						candidates.add(resolved + ext);
					}
				}
			}

			for (const { idx, name } of group.nameEdges) {
				for (const file of candidates) {
					const exps = exportsByFile.get(file);
					if (exps && exps.has(name)) {
						edges[idx].target = exps.get(name);
						break;
					}
				}
			}
		}
	})();

	return {nodes, edges, files, changedFiles, errors};
}