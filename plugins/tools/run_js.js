import {fileAccess} from "./fileAccess.js";
import {showToast} from "/src/components/Toast.js";
import {prettyError} from "/src/utils/utils.js";
import {AS_IS} from "unconscious";
import {createSandbox} from "unconscious/common/safe-worker/safe-worker.js";
import {normalizePath} from "unconscious/common/path-utils.js";
import {getToolParameters, runTools} from "/src/toolset.js";
import {formatSize} from "unconscious/common/Utils.js";
import {deepEqual} from "unconscious/common/deepEqual.js";

let worker;
let workerPermissions;
const stopWorker = (m) => {
	worker?.destroy(m);
	worker = null;
};

export const JS_MODULES = {
	'json5': {
		path: "assets/sandbox/json5.mjs",
		description: `Fast Streaming JSON5 Parser
export {
  createJsonParser(
    /**
     * 解析到新值和字符串片段时的回调函数。
     * @param path - 当前值所在的路径，元素为键名（字符串）或数组索引（数字）。
     * @param value - 解析到的值。当 \`isPartial\` 为 true 时，value 为字符串片段内容。
     * @param isPartial - 是否为部分字符串更新。为 true 时表示 value 仅是字符串的一部分。
     */
    onValue: (path: (string | number)[], value: any, isPartial: boolean) => void,
    options?: {
      /**
       * 当解析字符串未完成时，是否回调完整的已解析字符串前缀（prefix），
       * 还是仅传递新增部分（delta）。
       * 当 \`isPartial\` 为 false 时，\`value\` 总是完整字符串。
       */
      emitDelta?: boolean = false;
      json5?: boolean = false;
    }
  ): {
    write(chunk: string): void;
    end(): any;
  },
  parseJson5(str: string): any,
}`
	},
	'base64': {
		path: "builtin",
		description: `Ultrafast Streaming Base64 Encoder/Decoder
export {
  createBase64Encoder(urlSafe = false, bufferCapacity = 1024): { 
    encode(input: Uint8Array): Generator<Uint8Array, void>;
    finish(): Uint8Array;
  },
  createBase64Decoder(bufferCapacity = 1024): { 
    decode(input: string): Generator<Uint8Array, void>;
    finish(): Uint8Array;
  },
  base64Encode(input: Uint8Array | string (utf-8), urlSafe = false, bufferCapacity = 1024): string,
  base64DecodeToUint8Array = (input: Uint8Array | string, bufferCapacity = 4096): Uint8Array,
  base64DecodeToString(input: Uint8Array | string, charset = 'utf-8', bufferCapacity = 4096): string
}`
	},
	'SHA256': {
		path: "assets/sandbox/SHA256.mjs",
		description: `Ultrafast Streaming SHA256 Hasher
export class SHA256 {
    update(data: string | Uint8Array): this;
    digest(format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
    /** alias of digest('hex') */
    toString(): string;
    static hash(data: string | Uint8Array, format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
}}`
	},
	'text-diff': {
		path: "assets/diff.js",
		description: `Myers diff algorithm.
export {
  textDiff(a: string[], b: string[], trimSame = false): {
    type: 'same' | 'add' | 'del',
    oldIndex: number | null,
    newIndex: number | null,
    text: string
  }[]
}`
	},
	'xml-parser': {
		path: "assets/sandbox/xml-parser.min.mjs",
		description: `Fast Streaming XML Parser.
export {
  createXmlParser(
    handlers: {
      onOpenTag(qname: string, attrs: Record<string, string>, isSelfClosing: boolean): void;
      onCloseTag(qname: string): void;
      onText(text: string): void;
      onComment?(text: string): void;
      onCData?(text: string): void;
      onPI?(target: string, data: string): void;
      onError?(message: string, chunk: string): void;
    },
    options?: {
      decodeEntities?: boolean = true;
    }
  ): {
    write(chunk: string): void;
    end(): void;
  },
  parseXmlToTree(str: string, options?: {
    // XML Entities
    decodeEntities?: boolean = true;
    includeComments?: boolean = false;
    // \`<?...?>\` processing-instruction
    includePI?: boolean = false;
  }): XmlElement,
}
\`\`\`ts
  type XmlElement = { type: 'element', name: string, attrs: Record<string, string>, children: XmlNode[] };
  type XmlTextNode = { type: 'text' | 'comment' | 'cdata', content: string; };
  type XmlPI = { type: 'pi', target: string, data: string; };
  type XmlNode = XmlElement | XmlTextNode | XmlPI;
\`\`\``
	},
	jszip: {
		path: "assets/sandbox/jszip-shim.min.mjs",
		description: "Ultrafast JSZip v3 shim (30x faster)\nexport default JSZip;\nexport { crc32(data: Uint8Array): number }"
	},
	mathjs: {
		url: 'https://unpkg.com/mathjs@15.1.0/lib/browser/math.js',
		path: "assets/sandbox/math.js",
		description: "v15.1.0\nexport default math;"
	},
	papaparse: {
		path: "assets/sandbox/papaparse.min.js",
		description: "v5.0.2"
	},
	dayjs: {
		alias: ['dayjs/locale/zh-cn', 'dayjs/plugin/isLeapYear'],
		url: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js',
		path: "assets/sandbox/dayjs.min.js",
		description: "v1.x\n- builtins: locale/zh-cn, plugin/isLeapYear (DO NOT IMPORT, THEY ARE ALREADY USABLE)",
		//umd: true
	},
	xlsx: {
		path: "assets/sandbox/xlsx.mini.min.js",
		description: "v0.20.3 (mini, SheetJS)\nexport default XLSX;\n- XLSX.write 类型可用: [array: ArrayBuffer, buffer: Uint8Array, base64, binary]"
	},
	'pdf-lib': {
		url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
		path: "assets/sandbox/pdf-lib.min.js",
		description: "v1.17.1\nexport { PDFDocument, rgb, StandardFonts, ... }\n- 无法渲染中文，需要自行提供中文字体",
		umd: true
	},
	docx: {
		path: "assets/sandbox/docx.min.mjs",
		description: "v9.7.1\nexport { Document, Paragraph, Table, ... }"
	},
	lamejs: {
		url: 'https://unpkg.com/lamejs@1.2.1/lame.min.js',
		path: "assets/lame.min.mjs",
		description: "v1.2.1\nexport { Mp3Encoder, WavHeader }"
	},
	pptxgenjs: {
		url: 'https://cdn.jsdelivr.net/gh/gitbrent/pptxgenjs/dist/pptxgen.min.js',
		path: "assets/sandbox/pptxgen.min.mjs",
		description: "v4.0.1\nexport default pptxgen;\n- 用 addSlide() 而非 addNewSlide()\n- outputType 用 \"arraybuffer\" 或 \"uint8array\"，不能用 \"nodebuffer\"\n- 用 ChartType 而非 Charts"
	},
};
const aliases = new Set(Object.values(JS_MODULES).map(k => k.alias).filter(Boolean).flat());
const loadSystemModule = (mod) => {
	const promise = fetch(mod.path || mod.url, {
		referrerPolicy: 'no-referrer',
	}).then(res => {
		const content = res.headers.get('content-type');
		if (!res.ok) throw new Error('Failed to fetch module '+mod.path+': HTTP '+res.status);
		if (!content?.includes("javascript")) throw new Error('Failed to fetch module '+mod.path+': illegal content-type '+content);
		return res.text();
	});
	if (mod.umd) return promise.then(cjsWrapper);
	return promise;
}

// [ func, in, out ]
const rpcMethods = {
	read: [ (args) => ({ path: args[0], noTruncate: true }), AS_IS ],
	write: [ (args) => ({ path: args[0], content: args[1], overwrite: true }) ],
	append: [ (args) => ({ path: args[0], content: args[1], newline: false }) ],
	mkdir: [ (args) => ({ path: args[0] }) ],
	delete: [ (args) => ({ path: args[0] }) ],
	list: [ (args) => ({ path: args[0], json: args[1], pattern: args[2] || '*' }), AS_IS ],
	stat: [ (args) => ({ path: args[0] }), AS_IS ],
	copy: [ (args) => ({ src: args[0], dest: args[1], move: args[2] || false }) ],
};

rpcMethods["readRaw"] = [...rpcMethods['read']];
for (const key of ['write', 'append']) {
	rpcMethods[key+"Raw"] = [
		...rpcMethods[key],
		(result, args) => args[2]?.transfer && args[1]
	];
}

for (const key in rpcMethods) {
	rpcMethods[key].unshift(fileAccess(key));
}

const readFile = fileAccess("read");
const appendFn = fileAccess("append");

const MAX_OUTPUT_LENGTH = 20000;
const HALF = MAX_OUTPUT_LENGTH / 2;

const cjsWrapper = text => `const module = {exports};` + text + "\n;Object.assign(exports,module.exports)";

/**
 * @type {AiChat.FunctionTool}
 */
export const RunJS = {
	name: "RunJS",
	description: `Execute a JavaScript module (ESM) in sandbox.
- ES2023+, top-level await, import, import attributes and dynamic import(), no live bindings.
- Access file system via \`fs/promises\` and \`path\` module and equivalent global object.
- Not Node.js environment: no require(), no fs.readSync (\`fs/promises\' shim only), no http (use \`fetch\` and other browser APIs).
- After the module evaluated, the sandbox detaches — lingering async tasks will fail, be sure to await all Promises.
- For Uint8Array, use \`fs.writeFile(path, data, { transfer: true })\` (or appendFile) to transfer the buffer ownership for better performance. The returned promise resolves to a new Uint8Array with the same content; the original buffer becomes invalid.`,
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to a JS file."
			},
			code: {
				type: "string",
				description: "Inline code (deprecated). Mutually exclusive with `path`.",
			},
			this: {
				type: "object",
				description: "Top-level this. Must be JSON-serializable. Use this to pass data (as arguments) so you don't need to edit JS files repeatedly."
			},
			reset: {
				type: "boolean",
				description: "Restart sandbox, clear module cache and globalThis. Automatic reset on timeout."
			},
			permissions: {
				type: "array",
				items: {
					enum: ['network']
				}
			},
			timeout: {
				type: "integer",
				default: 10,
				maximum: 120,
				description: "(in seconds)"
			}
		}
	},
	title(tc, ctx) {
		const args = getToolParameters(ctx, tc);
		let label = '运行';
		if (args.path) label += ' '+args.path;
		else label += `内联代码 (${formatSize(args.code?.length)})`;
		return label;
	},

	async script({code, path, this: context, timeout = 10, permissions, reset }, response, conv) {
		if (null == code) {
			if (null == path) throw 'Neither path nor code is specified';
			code = await readFile({
				path,
				noTruncate: true
			}, response, conv);
			path = normalizePath(path).join('/');
		} else {
			if (path != null) throw 'Both path and code are specified';
		}

		if (reset || !worker || !deepEqual(workerPermissions, permissions || [])) {
			stopWorker();
			const hostModules = new Map;
			hostModules.set('@tools', {});

			const handlers = { hostModules };
			worker = createSandbox(handlers, permissions?.includes('network') ? ['fs', 'net'] : ['fs'], { hostModules, name: "RunJS" });
			worker.handlers = handlers;
			workerPermissions = permissions || [];
		}

		// 它的存在不直接告知模型
		const hostModules = worker.handlers.hostModules;
		hostModules.set('@tools', new Proxy({}, {
			get(target, key) {
				const exist = conv.allowedTools.has(key);
				if (!exist) return;

				return async (args) => {
					const resp = [];

					await runTools({
						tool_calls: [{
							function: {
								name: key,
								arguments: JSON.stringify(args || {})
							}
						}],
						tool_responses: resp
					}, conv, 0);

					return resp[0];
				}
			}
		}))

		const timer = setTimeout(() => stopWorker("Error: Timeout or deadlock"), timeout * 1000);

		worker.handlers.load = (path, systemModule) => {
			if (systemModule) {
				if (aliases.has(path)) {
					worker.handlers.log('[WARN] Builtin module '+path+' is alias, DO NOT IMPORT, THEY ARE ALREADY USABLE.');
					return '';
				}
				const mod = JS_MODULES[path];
				if (!mod) throw new Error('Module not found: '+path);
				return loadSystemModule(mod);
			}
			const promise = readFile({
				path,
				noTruncate: true
			}, response, conv);
			if (path.endsWith(".cjs")) return promise.then(cjsWrapper);
			return promise.catch(e => { throw ("Could not fetch module "+path) });
		}

		// 文件 RPC 处理
		worker.handlers.rpc = async (method, args, transfer) => {
			const [func, input, output] = rpcMethods[method];
			try {
				let result = await func(input(args), response, conv);
				if (output) {
					const array = args.find(x => x instanceof Uint8Array);
					if (array) transfer.push(array.buffer);
					return output(result, args);
				}
			} catch (e) {
				if (typeof e === 'string')
					throw new Error(e);
				throw e;
			}
		};

		// 日志写入处理
		let head = '', tail = '';
		let totalChars = 0;
		let logFile = null;

		worker.handlers.log = (log) => {
			const line = log + '\n';
			totalChars += line.length;
			tail += line;

			if (logFile) {
				appendToLogFile(line);
				tail = tail.slice(-HALF);
			} else if (totalChars > MAX_OUTPUT_LENGTH) {
				logFile = './code-log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '.log';

				appendToLogFile(tail);
				head = tail.slice(0, HALF);
				tail = tail.slice(tail.length - HALF);
			}
		};

		const getLog = () => (head ? head + `\n[Output too large (${totalChars} chars). Full output saved to: ${JSON.stringify(logFile)}]\n` : '') + tail;

		let buffer = '';
		let promise;
		const appendToLogFile = (content, flush) => {
			buffer += content;
			if (buffer.length > 524288 || flush) {
				const mybuf = buffer;
				buffer = '';

				const next = () => appendFn({ path: logFile, content: mybuf }, response, conv);
				return promise = promise ? promise.then(next, (e) => {
					showToast("日志写入失败\n"+prettyError(e), 'error');
				}) : next();
			}
		};

		const detachLogs = worker.handlers.detachLogs;
		if (detachLogs) tail += '[WARN] After the last RunJS call returned, there were still unresolved Promises. Be sure to await all Promises!\n';

		let err = '';
		try {
			await worker.initialize();
			await worker.execute(
				path,
				code,
				context
			);
		} catch (e) {
			err = prettyError(e);
		} finally {
			clearTimeout(timer);
			if (logFile) appendToLogFile('', true);
			if (worker) {
				hostModules.clear();
				const handlers = worker.handlers;
				delete handlers.rpc;
				delete handlers.load;
				handlers.detachLogs = 0;
				handlers.log = (log) => {
					handlers.detachLogs ++;
					console.log('[RunJS]', log);
				}
			}
		}

		return (getLog()+err) || '[No console output]';
	}
};

/**
 * @type {AiChat.FunctionTool}
 */
export const SearchModules = {
	name: "SearchModules",
	description: `Find RunJS modules. (archive, office, audio, xml, etc.). Search for candidates before say no.`,
	parameters: {
		type: "object",
		properties: {
			keywords: {
				type: "string",
				description: "space seperated keywords"
			},
			limit: {
				type: "integer",
				default: 20,
			}
		}
	},
	title(tc, ctx) {
		const args = getToolParameters(ctx, tc);
		let label = '查询模块';
		if (args.keywords) label += ' '+args.keywords;
		return label;
	},

	async script({ keywords = '', limit = 20 }, response, conv) {
		const kws = keywords.toLowerCase().split(' ');
		const keys = [];
		const entries = Object.entries(JS_MODULES);
		for (const [key, { description }] of entries) {
			if (!kws.length || kws.some(filter => key.includes(filter) || description.includes(filter))) {
				keys.push(key+": "+description);
				if (keys.length >= limit) break;
			}
		}

		if (!keys.length) return `No module found.
---
Note: OffscreenCanvas, crypto.subtle and other DedicatedWorkerGlobalScope objects may be used.`

		return `Found ${keys.length} modules.
---
`+keys.join("\n\n");
	}
};