/**
 * Code Graph Plugin — Multi-language code graph analysis with tree-sitter.
 *
 * Parses source code into a queryable knowledge graph, revealing:
 *   - Function/class definitions and their relationships
 *   - Call graphs (who calls what)
 *   - Import/dependency chains
 *   - Inheritance hierarchies
 *   - Impact radius analysis
 *
 * Architecture inspired by:
 *   - code-review-graph (SQLite-backed graph, node/edge model)
 *   - graphify-8 (LanguageConfig dispatch, per-language AST types)
 *
 * Uses web-tree-sitter WASM grammars for 11 languages:
 *   JavaScript, TypeScript, TSX, Go, Java, C, C++, C#, CSS, HTML, JSON
 *
 * MCP Tools:
 *   - parse_file:   Parse a single file → nodes + edges
 *   - build_graph:  Scan a directory → persisted code graph
 *   - query_graph:  Query callers, callees, imports, impact radius
 *   - search_graph: Search nodes by name
 *   - graph_stats:  Database statistics
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {availableLanguages, buildGraph, loadParsers} from "./engine.js";
import {SUPPORTED_EXTENSIONS} from "./languages.js";

const { MCPServer, LRUCache, cachePreparedSql } = globalThis.AiChatAPI;

const mcp = new MCPServer({
	name: 'CodeGraph-MCP',
	version: '1.0.0',
});

let dataDir;

/**
 * Plugin default export. Receives Router instance and workspace path.
 * Initializes tree-sitter parsers and registers MCP tools.
 *
 * @param {AiChatBackend.Router} router
 * @param {string} workspace
 */
export default async (router, workspace) => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	await loadParsers(path.join(__dirname, 'languages.zip'));

	dataDir = path.join(workspace, '.codegraph');
	await fs.promises.mkdir(dataDir, {recursive: true});

	// TODO obtain fs_base 无论如何我都不可能让绝对路径成为默认选择
	const realWorkspace = workspace;

	mcp.tool('BuildGraph',
		`Build or update a code graph for all supported source files in a directory.`,
		{
			type: 'object',
			properties: {
				directory: {
					type: 'string',
					description: 'Directory to scan.'
				},
				rebuild: {
					type: 'boolean',
					default: false,
				},
			},
			required: ['directory'],
		},
		async ({directory, rebuild}, ctx) => {
			let dir = directory;
			if (!path.isAbsolute(dir)) dir = path.join(realWorkspace, dir);

			try {
				await fs.promises.access(dir);
			} catch {
				return err(`Directory not found: ${dir}`);
			}

			const db = getDatabase(dir);
			const buildStart = Date.now();

			// ── Determine "since" timestamp ──
			let since = 0;
			if (!rebuild) {
				const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_build');
				if (row) since = Number(row.value) || 0;
			}

			// ── Full rebuild: truncate tables ──
			if (rebuild && since === 0) {
				db.exec('DELETE FROM nodes; DELETE FROM edges;');
			}

			const {files, changedFiles, nodes, edges, errors} = await buildGraph(dir, realWorkspace, {
				since,
			});

			// ── Persist ──
			if (changedFiles.length) {
				// Delete old data for changed files
				for (const file of changedFiles) {
					db.prepare('DELETE FROM nodes WHERE file = ?').run(file);
					db.prepare('DELETE FROM edges WHERE file = ?').run(file);
				}

				// Insert new data
				const insertNode = db.prepare('INSERT INTO nodes (kind, name, qname, file, lineStart, lineEnd, parent, signature, modifiers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
				const insertEdge = db.prepare('INSERT INTO edges (kind, source, target, file, line) VALUES (?, ?, ?, ?, ?)');
				for (const n of nodes) insertNode.run(n.kind, n.name, n.qname, n.file, n.lineStart, n.lineEnd, n.parent || null, n.signature || null, n.modifiers || null);
				for (const e of edges) insertEdge.run(e.kind, e.source, e.target, e.file, e.line);
			}

			// ── Remove stale entries for deleted files ──
			const fsFiles = new Set(files);
			const dbFiles = db.prepare('SELECT DISTINCT file FROM nodes').all().map(r => r.file);
			for (const f of dbFiles) {
				if (!fsFiles.has(f)) {
					db.prepare('DELETE FROM nodes WHERE file = ?').run(f);
					db.prepare('DELETE FROM edges WHERE file = ?').run(f);
				}
			}

			// ── Update last_build timestamp ──
			db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_build', String(buildStart));
			db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

			// Re-count from DB for accurate stats after incremental
			const dbNodeCounts = db.prepare('SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind').all();
			const dbEdgeCounts = db.prepare('SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind').all();
			const dbFileCount = db.prepare('SELECT COUNT(DISTINCT file) as cnt FROM nodes').get();

			return `
Graph built.

files: ${dbFileCount?.cnt || 0}
nodes: ${dbNodeCounts.reduce((s, r) => s + r.cnt, 0)}
edges: ${dbEdgeCounts.reduce((s, r) => s + r.cnt, 0)}
nodes_by_kind: ${JSON.stringify(Object.fromEntries(dbNodeCounts.map(r => [r.kind, r.cnt])))}
edges_by_kind: ${JSON.stringify(Object.fromEntries(dbEdgeCounts.map(r => [r.kind, r.cnt])))}
errors: ${errors.length}
${errors.slice(0, 20).join('\n')}`.trim()
		},
	);

	mcp.tool('QueryGraphEdge',
		`Search for relations (edge) in the code graph:
  relations — all edges involving this symbol, with direction
  imports   — import edges for a file
  impact    — BFS traversal showing edge paths from a starting symbol`,
		{
			type: 'object',
			properties: {
				directory: {type: 'string',},
				symbol: {
					type: 'string',
					description: 'Symbol qualifiedName. E.g. "src/foo.js::sendMessage".'
				},
				query: {
					enum: ['relations', 'imports', 'impact'],
					default: 'relations',
				},
				kinds: {
					type: 'array',
					items: {
						enum: ['CALLS', 'IMPORTS', 'INHERITS', 'CONTAINS', 'REFERENCES']
					},
					description: 'Filter by edge kind. Empty = all kinds. Applies to relations only.'
				},
				depth: {type: 'integer', default: 3, description: 'BFS depth. Applies to impact only.'},
				limit: {type: 'integer', default: 30},
			},
			required: ['directory', 'symbol'],
		},
		({directory, symbol, query, kinds, depth = 3, limit = 30}) => {
			let dir = directory;
			if (!path.isAbsolute(dir)) dir = path.join(realWorkspace, dir);
			const db = getDatabase(dir);

			if (!symbol.includes("::")) {
				let row = db.prepare(`SELECT qname FROM nodes WHERE qname = ?`).get(symbol);
				if (!row) {
					row = db.prepare(`SELECT qname FROM nodes WHERE name = ?`).get(symbol);
					if (row) symbol = row.qname;
				}
			}

			const ekWhere = (kinds?.length) ? `AND e.kind in (${kinds.map(i=>`'${i}'`).join(', ')})` : '';

			switch (query) {
				// ── relations: all edges with direction ──
				case 'relations': {
					const rows = db.prepare(`
            SELECT e.*,
              CASE WHEN e.source = ?1 THEN 'outgoing' WHEN e.target = ?1 THEN 'incoming' END as direction
            FROM edges e
            WHERE (e.source = ?1 OR e.target = ?1) ${ekWhere}
            ORDER BY direction, e.kind, e.file, e.line
            LIMIT ?2
`).all(symbol, limit);
					return formatOutput(rows);
				}

				// ── imports: file-level import edges ──
				case 'imports': {
					const rows = db.prepare(`SELECT * FROM edges WHERE source = ? AND kind = 'IMPORTS' ORDER BY line`).all(symbol);
					return formatOutput(rows);
				}

				// ── impact: BFS traversal returning edge paths ──
				case 'impact': {
					const visited = new Set([symbol]);
					let frontier = [symbol];
					const results = [];
					const seenEdges = new Set();

					for (let d = 0; d < depth && frontier.length > 0 && results.length < limit; d++) {
						// ── Build IN clause placeholders ──
						const ph = frontier.map(() => '?').join(',');

						// Filter: don't expand from nodes contained by a file (original semantics)
						let expand = frontier;
						const contained = db.prepare(
							`SELECT DISTINCT target FROM edges WHERE kind = 'CONTAINS' AND source IN (${ph})`
						).all(...frontier);
						const skip = new Set(contained.map(r => r.target));
						expand = frontier.filter(n => !skip.has(n));

						if (expand.length === 0) break;

						const eph = expand.map(() => '?').join(',');
						// Query all edges touching the expand set in one shot
						const edges = db.prepare(
							`SELECT * FROM edges WHERE source IN (${eph}) OR target IN (${eph})`
						).all(...expand, ...expand);

						const expandSet = new Set(expand);
						const next = new Set();

						for (const e of edges) {
							if (results.length >= limit) break;
							const neighbor = expandSet.has(e.source) ? e.target : e.source;
							const key = `${e.kind}|${e.source}|${e.target}`;
							if (!visited.has(neighbor) && !seenEdges.has(key)) {
								visited.add(neighbor);
								seenEdges.add(key);
								next.add(neighbor);
								results.push({ depth: d + 1, kind: e.kind, source: e.source, target: e.target });
							}
						}

						frontier = [...next];
					}

					return formatOutput(results);
				}
			}
		},
	);

	mcp.tool('QueryGraphNode',
		'Search for symbols (node) in the code graph.',
		{
			type: 'object',
			properties: {
				directory: {type: 'string',},
				symbol: {type: 'string', description: 'Partial symbol name.'},
				kinds: {
					type: 'array',
					items: {
						enum: ['Function', 'Class', 'Variable', 'File'],
					},
					description: 'Filter by kind.'
				},
				limit: {type: 'integer', default: 30},
			},
			required: ['directory', 'symbol'],
		},
		({directory, symbol, kinds, limit = 30}) => {
			let dir = directory;
			if (!path.isAbsolute(dir)) dir = path.join(realWorkspace, dir);
			const db = getDatabase(dir);

			const rows = db.prepare(`SELECT * FROM nodes WHERE ${
				kinds?.length ? `kind IN (${kinds.map(i => `'${i}'`).join(', ')}) AND` : ''
			} qname LIKE ? ORDER BY name LIMIT ?`).all(`%${symbol}%`, limit);
			return formatOutput(rows);
		},
	);

	mcp.tool('QueryGraphInfo',
		'Get statistics about an code graph.',
		{
			type: 'object',
			properties: {
				directory: {type: 'string',},
			},
			required: ['directory']
		},
		({directory}) => {
			let dir = directory;
			if (!path.isAbsolute(dir)) dir = path.join(realWorkspace, dir);
			const db = getDatabase(dir);

			const nk = db.prepare(`SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind`).all();
			const ek = db.prepare(`SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind`).all();
			const fc = db.prepare(`SELECT COUNT(DISTINCT file) as cnt FROM nodes`).get();
			return `total_files: ${fc?.cnt || 0}
nodes_by_kind: ${Object.fromEntries(nk.map(r => [r.kind, r.cnt]))}
edges_by_kind: ${Object.fromEntries(ek.map(r => [r.kind, r.cnt]))}
available_parsers: ${availableLanguages()}
supported_extensions: ${[...SUPPORTED_EXTENSIONS.keys()]}`;
		},
	);

	mcp.mount(router, 'mcp/codeGraph');
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cache = new LRUCache(4);

const err = msg => MCPServer.toolError(msg);

const formatOutput = d => d.map(row => {
	// Edge
	if (row.source) {
		let str = row.kind;
		if (row.depth !== undefined) str += ` (depth ${row.depth})`;
		if (row.direction) str += ` [${row.direction}]`;
		str += `\nsource: ${row.source}`;
		if (row.line) str += `\nsourceLine: ${row.line}`;
		str += `\ntarget: ${row.target}`;
		return str;
	}

	// Node
	let str= `${row.kind}\nqualifiedName: ${row.qname}`;

	const sign = (row.modifiers?row.modifiers+' ':'')+row.name+(row.signature||'');
	if (!row.qname.endsWith("::"+sign) && row.file !== row.name) str += '\nsignature: '+sign;

	const {lineStart, lineEnd} = row;
	if (lineStart === lineEnd) str += '\nline: '+lineStart;
	else str += `\nlineRange: [${row.lineStart}, ${row.lineEnd}]`;

	if (row.parent) str += '\n'+row.parent;

	return str;
}).join('\n\n') || '[No results]';

/**
 *
 * @param {string} dir
 * @returns {DatabaseSync}
 */
const getDatabase = (dir) => {
	let db = cache.get(dir);
	if (!db) {
		db = new DatabaseSync(path.join(dataDir, 'cg_'+encodeURIComponent(dir)+'.db'));
		db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
		db.exec(`
    CREATE TABLE IF NOT EXISTS meta
    (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes
    (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        kind      TEXT NOT NULL,
        name      TEXT NOT NULL,
        qname     TEXT NOT NULL,
        file      TEXT NOT NULL,
        lineStart INTEGER,
        lineEnd   INTEGER,
        parent    TEXT,
        signature TEXT,
        modifiers TEXT
    );

    CREATE TABLE IF NOT EXISTS edges
    (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        kind    TEXT NOT NULL,
        source  TEXT NOT NULL,
        target  TEXT NOT NULL,
        file    TEXT NOT NULL,
        line    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes (file);
    CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes (kind);
    CREATE INDEX IF NOT EXISTS idx_nodes_qname ON nodes (qname);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes (parent);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
    CREATE INDEX IF NOT EXISTS idx_edges_file ON edges (file);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges (kind);
`);
		cachePreparedSql(db);
		cache.set(dir, db, 0);
	}

	return db;
};