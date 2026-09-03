import {msgpack_schema, msgpack_schema_version} from "../common/MsgpackSchema.js";
import {constants, createBrotliCompress, createGzip} from "node:zlib";
import {RESPONSE_COMPRESS_LEVEL, RESPONSE_USE_MSGPACK_SCHEMA} from "./config.js";
import {decodeMsg, encodeRawMsg} from "unconscious/common/msgpack.js";

const FLAG = {
	PREFIX:    1,  // prefix delegation (/**)
	DIRECTORY: 2,  // expects trailing slash
	FILE:      4,  // expects no trailing slash
};

class RouteEntry {
	constructor(method, handler) {
		this.method = method;
		this.handler = handler;
	}
}

class RouteNode {
	/** @type {Map<string, RouteNode>} literal segments lookup */
	#children = null;

	/** @type {ParamNode[]} dynamic (regex) children */
	#params = null;

	/** @type {RouteEntry[]} handler entries (one per method) */
	value = null;

	/** @type {number} bitmask of FLAG constants */
	flag = 0;

	constructor(name) {
		this.name = name;
	}

	/**
	 * Priority for disambiguation when multiple nodes match.
	 * Higher = preferred. Mirror of OKRouter's RouteNode.priority().
	 */
	priority() {
		let p = 5;                              // base: literal
		if ((this.flag & FLAG.PREFIX) === 0) p++; // complete > prefix
		return p;
	}

	/**
	 * Insert a path into the subtree rooted at this node.
	 *
	 * @param {string} path  full path being inserted
	 * @param {number} i     current position in path
	 * @param {number} end   end of path
	 * @returns {RouteNode} the leaf node where handlers should be stored
	 */
	add(path, i, end) {
		if (i >= end) return this;

		// Find segment boundary
		let j = path.indexOf('/', i);
		if (j < 0 || j >= end) j = end;
		if (i >= j) return this.add(path, j + 1, end); // skip empty segments

		if (path.charAt(i) === ':') {
			return this.#addParam(path, i, j, end);
		}

		// Literal segment — use hash table
		if (this.#children === null) {
			this.#children = new Map();
		}

		const seg = path.substring(i, j);
		let child = this.#children.get(seg);
		if (!child) {
			child = new RouteNode(seg);
			this.#children.set(seg, child);
		}
		return child.add(path, j + 1, end);
	}

	/**
	 * Add a parameterized (dynamic) child node.
	 */
	#addParam(path, i, j, end) {
		const seg = path.substring(i, j);

		// Parse ":name(regex)?quantifier"
		const m = seg.match(/^:([A-Za-z0-9_-]+)(?:\((.+?)\))?([+*?])?$/);
		if (!m) throw new Error('Invalid param segment: ' + seg);

		const name = m[1];
		const regex = m[2] || null;
		const quantifier = m[3] || null;

		let node = new ParamNode(name, regex, quantifier);

		if (this.#params === null) this.#params = [];

		// Deduplicate: reuse existing ParamNode with same signature
		const existing = this.#params.find(p => p.equals(node));
		if (existing) {
			node = existing;
		} else {
			// Greedy param at the end of path: store as leaf value (special case)
			if (node.isGreedy && j >= end) {
				if (this.value !== null) {
					throw new Error('Duplicate route at greedy param: ' + path);
				}
				// We still add to params for matching, but also mark as value-capable
			}
			this.#params.push(node);
		}

		return node.add(path, j + 1, end);
	}

	/**
	 * Collect children that match the given path segment [start, end).
	 *
	 * Called by PathMatcher during tree walk.
	 * Mirrors OKRouter's RouteNode.get().
	 *
	 * @param {string} path
	 * @param {number} start
	 * @param {number} end
	 * @param {RouteNode[]} nodes  output: matching child nodes appended here
	 */
	match(path, start, end, nodes) {
		// 1. Try literal match (O(1) hash lookup)
		if (this.#children !== null) {
			const seg = path.substring(start, end);
			const literal = this.#children.get(seg);
			if (literal) {
				nodes.push(literal);
			}
		}

		// 2. Try each param child
		if (this.#params !== null) {
			for (const pn of this.#params) {
				pn.matchSegment(path, start, end, nodes);
			}
		}
	}

	toString() {
		return this.name;
	}
}

/**
 * Dynamic (parameterized) segment node.
 *
 * Supports patterns like:
 *   :id           — matches any single segment
 *   :id(\d+)      — matches a single segment with regex constraint
 *   :rest*        — matches zero or more remaining segments (greedy)
 *   :rest+        — matches one or more remaining segments (greedy)
 *   :opt?         — matches zero or one segment (optional)
 */
class ParamNode extends RouteNode {
	/**
	 * @param {string} paramName
	 * @param {string|null} pattern  regex source string (without delimiters)
	 * @param {string|null} quantifier  '+', '*', '?', or null
	 */
	constructor(paramName, pattern, quantifier) {
		super(':' + paramName);
		this.paramName = paramName;
		this.pattern = pattern ? new RegExp('^(?:' + pattern + ')$') : null;
		this.quantifier = quantifier;
	}

	get isGreedy()  { return this.quantifier === '+' || this.quantifier === '*'; }
	get isOptional() { return this.quantifier === '?' || this.quantifier === '*'; }

	/**
	 * Test whether this param node matches the segment and append to nodes.
	 */
	matchSegment(path, start, end, nodes) {
		const seg = path.substring(start, end);

		if (this.pattern) {
			if (!this.pattern.test(seg)) {
				// Optional: skip this param but still expose children
				if (this.isOptional) {
					// Null-match: push ourselves so children can be explored
					// but mark for null-param-value extraction
					nodes.push(this);
				}
				return;
			}
		}

		nodes.push(this);
	}

	/**
	 * Priority: lower than literal, higher when constrained/required.
	 */
	priority() {
		let p = 0;
		if (!this.isGreedy && !this.isOptional) p++; // exact > greedy
		if (!this.isOptional) p++;                     // required > optional
		if (this.pattern) p++;                          // constrained > unconstrained
		return p;
	}

	equals(other) {
		if (!(other instanceof ParamNode)) return false;
		if (this.paramName !== other.paramName) return false;
		if (this.quantifier !== other.quantifier) return false;
		if (this.pattern && other.pattern) {
			return this.pattern.source === other.pattern.source;
		}
		return this.pattern === other.pattern;
	}
}

class PathMatcher {
	// Two alternating stacks
	#nodeS = [];
	#nodeD = [];
	#parS  = [];   // accumulated param names+values per node in nodeS
	#parD  = [];   // same for nodeD

	// Prefix match tracking (for /** delegation)
	#prefixLen = 0;
	#prefixNode = null;
	#prefixParams = null;

	// Final results
	/** @type {RouteNode} */
	#node = null;
	/** @type {(string|null)[]} */
	#params = null;

	/**
	 * Walk the route trie for `path` from `start` to `end`.
	 *
	 * @param {string} path
	 * @param {number} start
	 * @param {number} end
	 * @param {RouteNode} root
	 * @param {string} method  HTTP method name
	 * @returns {[]}
	 */
	match(path, start, end, root, method) {
		let nodeS = this.#nodeS;
		let nodeD = this.#nodeD;
		let parS  = this.#parS;
		let parD  = this.#parD;

		nodeS.length = 0;
		parS.length  = 0;
		nodeS.push(root);

		this.#node =
		this.#params =
		this.#prefixNode =
		this.#prefixParams  = null;

		let i = start;
		let prevI = start;

		while (i < end) {
			let nextI = path.indexOf('/', i);
			if (nextI < 0 || nextI >= end) nextI = end;

			for (let k = 0; k < nodeS.length; k++) {
				const node = nodeS[k];

				// ── Carry forward accumulated params from parent param nodes ──
				let myParams = null;
				if (node instanceof ParamNode) {
					// Clone parent params and append this segment's value
					const parentParams = parS[k] || null;
					myParams = parentParams ? parentParams.slice() : [];
					myParams.push(node.paramName);
					myParams.push(path.substring(prevI, i - 1)); // value between slashes
				} else {
					myParams = parS[k] || null;
				}

				// Ensure parD has an element at position k (may be sparse)
				while (parD.length <= k) parD.push(null);

				// ── Check prefix delegation (/**) ──
				if ((node.flag & FLAG.PREFIX) !== 0 && node.value !== null) {
					if (node.value.some(e => e.method === method)) {
						this.#prefixLen = i;
						this.#prefixNode = node;
						this.#prefixParams  = myParams;
					}
				}

				// ── Match children ──
				const before = nodeD.length;
				node.match(path, i, nextI, nodeD);

				// Assign params to newly added nodes
				for (let n = before; n < nodeD.length; n++) {
					parD[n] = myParams;
				}
			}

			if (nodeD.length === 0) {
				// No children matched — try prefix match as fallback
				nodeS.length = 0;
				parS.length  = 0;
				return this.#finish(method, path);
			}

			// Swap stacks
			let tmp = [nodeS, parS];
			nodeS = nodeD;
			parS = parD;
			[nodeD, parD] = tmp;
			nodeD.length = 0;
			parD.length  = 0;

			prevI = i;
			i = nextI + 1;
		}

		// ── End of path — select best leaf ──
		let bestNode = null;
		let bestPriority = -1;
		let bestParams = null;
		const isFile = path.length > 0 && path.charAt(end - 1) !== '/';

		for (let j = 0; j < nodeS.length; j++) {
			const node = nodeS[j];
			if (node.value === null) continue;

			// Directory/file check
			if ((node.flag & FLAG.DIRECTORY) !== 0 && isFile) continue;
			if ((node.flag & FLAG.FILE) !== 0 && !isFile) continue;

			// Method check
			if (!node.value.some(e => e.method === method)) continue;

			const prio = node.priority();
			if (prio > bestPriority) {
				bestNode = node;
				bestPriority = prio;
				bestParams = parS[j] || null;

				// If this node itself is a ParamNode, append the final segment value
				if (node instanceof ParamNode) {
					if (!bestParams) bestParams = [];
					bestParams.push(node.paramName);
					bestParams.push(path.substring(prevI, isFile ? end : end - 1));
				}
			} else if (prio === bestPriority && bestNode !== null && bestNode !== node) {
				throw new Error('Ambiguous routes: ' + bestNode + ' and ' + node);
			}
		}

		nodeS.length = 0;
		parS.length  = 0;

		if (bestNode !== null) {
			// Non-strict mode: strip trailing slash for file-typed routes
			if ((bestNode.flag & FLAG.DIRECTORY) === 0 && !isFile && end > 0) end--;
			this.#prefixLen = end;
			this.#node = bestNode;
			this.#params = bestParams;
		}

		return this.#finish(method, path);
	}

	/**
	 * @param {string} method
	 * @param {string} path
	 * @returns {unknown[]}
	 */
	#finish(method, path) {
		if (!this.#node) {
			this.#node = this.#prefixNode;
			this.#params = this.#prefixParams;
		}

		/** @type {RouteEntry} */
		const entry = this.#node?.value.find(e => e.method === method);
		if (entry) {
			// Build params object from extracted values
			const params = {};
			const extracted = this.#params;
			if (extracted) {
				for (let i = 0; i < extracted.length; i += 2) {
					const key = extracted[i], val = extracted[i + 1];
					params[key] = decodeURIComponent(val);
				}
			}

			return [entry.handler, params, path.substring(this.#prefixLen)];
		}
	}
}

export class Router {
	// 外部会改这个
	zipRouter;
	// hook
	#filter;

	/** @type {string[]} prefix stack */
	#prefixes = [];
	/** Root of the route trie (radix tree) */
	#root = new RouteNode('');
	#matcher = new PathMatcher();

	/**
	 * @param {function(AiChatBackend.RouteContext): boolean} filter
	 */
	constructor(filter) {
		this.#filter = filter;
	}

	push(path) { this.#prefixes.push(path); }
	pop()      { this.#prefixes.pop(); }

	get(path, handler)    { this.#add('GET', path, handler); }
	post(path, handler)   { this.#add('POST', path, handler); }
	put(path, handler)    { this.#add('PUT', path, handler); }
	delete(path, handler) { this.#add('DELETE', path, handler); }
	patch(path, handler)  { this.#add('PATCH', path, handler); }

	/**
	 * @param {string} method
	 * @param {string} path - vue-router compatible path format
	 * @param handler
	 */
	#add(method, path, handler) {
		// Build full path from prefix stack
		let fullPath = this.#prefixes.join('/') + path;
		if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;

		// Detect flags
		let flag = 0;
		if (fullPath.endsWith('/**')) {
			flag |= FLAG.PREFIX;
			fullPath = fullPath.substring(0, fullPath.length - 2); // strip "**"
		}
		if (fullPath.endsWith('/')) {
			flag |= FLAG.DIRECTORY;
		} else if (fullPath.length > 0) {
			flag |= FLAG.FILE;
		}

		// Insert into trie
		const node = this.#root.add(fullPath, 0, fullPath.length);

		const entry = new RouteEntry(method, handler);

		if (node.value === null) {
			node.value = [entry];
		} else {
			// Method conflict check
			if (node.value.some(e => e.method === method)) {
				throw new Error(
					`Conflicting route: ${method} ${fullPath} already registered`
				);
			}
			node.value.push(entry);
		}
		node.flag |= flag;
	}

	/**
	 * Main request handler. Walks the trie to find a matching route.
	 *
	 * @param {import("http").IncomingMessage} req
	 * @param {import("http").ServerResponse} res
	 * @return {Promise<void>}
	 */
	async handle(req, res) {
		let parsedUrl;
		try {
			parsedUrl = new URL(req.url, `http://${req.headers.host}`);
		} catch {
			res.end();
			return;
		}

		// Strip leading slash for matching
		const urlPath = parsedUrl.pathname.slice(1);
		let method = req.method.toUpperCase();

		// CORS
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ci, X-Pv, X-Sv');

		if (method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === 'HEAD') method = 'GET';

		// 谦让式协程就是爽啊，什么对象池都可以滚了
		const matcher = this.#matcher;
		const matched = matcher.match(urlPath, 0, urlPath.length, this.#root, method);

		if (matched) {
			const [handler, params, remainingPath] = matched;

			await this._invokeHandler(req, res, parsedUrl, urlPath, remainingPath, params, handler);
			return;
		}

		// ── Fallback: zipRouter ──
		if (this.zipRouter) {
			try {
				const ok = await this.zipRouter({
					path: urlPath,
					req,
					res,
				});
				if (ok) return;
			} catch (err) {
				console.error(err);
				res.end();
				return;
			}
		}

		// ── 404 ──
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Not Found' }));
	}

	/**
	 * Build the RouteContext and invoke the matched handler.
	 */
	async _invokeHandler(req, res, parsedUrl, urlPath, remainingPath, params, handler) {
		const variables = new Map();
		const newVariables = [];

		/** @type {AiChatBackend.RouteContext} */
		const ctx = {
			url: parsedUrl,
			path: urlPath,
			remainingPath,
			req,
			res,
			params,
			query: Object.fromEntries(parsedUrl.searchParams.entries()),
			searchParams: parsedUrl.searchParams,
			getVariable: (name) => variables.get(name) || null,
			setVariable(name) {
				let _resolve, _reject;
				const get = new Promise((resolve, reject) => {
					_resolve = resolve;
					_reject = reject;
				});
				get.catch(() => {});

				variables.set(name, get);
				newVariables.push(_reject);
				return _resolve;
			},
			variables: newVariables,
			send(status, data) {
				const {accept = '', ['x-sv']: x_msv} = req.headers;
				const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();

				let outputStream = res;
				let encoder, contentType;
				if (RESPONSE_USE_MSGPACK_SCHEMA && accept.includes('application/vnd.msgpack') && x_msv === msgpack_schema_version) {
					encoder = (data) => encodeRawMsg(data, (buf, shared) => {
						outputStream.write(shared ? Buffer.from(buf) : buf);
					}, {schema: msgpack_schema});
					contentType = 'application/vnd.msgpack';
				} else {
					encoder = (data) => outputStream.write(Buffer.from(JSON.stringify(data)));
					contentType = 'application/json';
				}

				let encoding;
				if (RESPONSE_COMPRESS_LEVEL && acceptEncoding.includes('br')) {
					const stream = createBrotliCompress({
						params: {
							[constants.BROTLI_PARAM_QUALITY]: RESPONSE_COMPRESS_LEVEL,
						}
					});
					stream.pipe(outputStream);
					outputStream = stream;
					encoding = 'br';
				} else if (acceptEncoding.includes('gzip')) {
					const stream = createGzip();
					stream.pipe(outputStream);
					outputStream = stream;
					encoding = 'gzip';
				}

				const headers = {
					'Content-Type': contentType,
					'Vary': 'Accept-Encoding',
				};
				if (encoding) headers['Content-Encoding'] = encoding;

				res.writeHead(status, headers);
				encoder(data);
				outputStream.end();
			},
			readAsBuffer: (maxLength = 1048576) => new Promise((resolve, reject) => {
				let chunks = [];
				let totalLength = 0;
				req.on('data', chunk => {
					const length = chunk.length;
					if (totalLength + length > maxLength) {
						const error = new Error('Request body too large');
						error.status = 413;
						reject(error);
						return;
					}
					totalLength += length;
					chunks.push(Buffer.from(chunk));
				});
				req.on('end', () => resolve(Buffer.concat(chunks)));
				req.on('error', reject);
			}),
			readAsString: (maxLength) => ctx.readAsBuffer(maxLength).then(String),
			readAsObject: async () => {
				const type = ctx.req.headers['content-type'];
				const buffer = await ctx.readAsBuffer();
				if (type === 'application/json') {
					return JSON.parse(buffer.toString());
				}
				if (type === 'application/vnd.msgpack') {
					return decodeMsg(buffer, { schema: msgpack_schema });
				}
				throw new Error('unknown content-type');
			},
		};

		let filter = this.#filter;
		if (typeof filter === 'function' && filter(ctx)) return;

		try {
			await handler(ctx);
		} catch (err) {
			console.error(err);

			let msg = err.message ?? err;
			if (ctx.errorFilter) msg = ctx.errorFilter(msg, err);
			try {
				ctx.send(err.status || 500, { error: msg });
			} catch {}
		}
	}
}
