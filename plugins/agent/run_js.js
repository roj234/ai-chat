import {crossVFSCopyMove, fileAccess} from "./Mounts.js";
import {showToast} from "/src/components/Toast.js";
import {getRandomString, prettyError} from "/src/utils/utils.js";
import {AS_IS} from "unconscious";
import {createSandbox} from "unconscious/common/safe-worker/safe-worker.js";
import {normalizePath} from "unconscious/common/path-utils.js";
import {getToolParameters, runTools} from "/src/toolset.js";
import {formatSize} from "unconscious/common/Utils.js";
import {deepEqual} from "unconscious/common/deepEqual.js";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {inspect} from "unconscious/common/inspect.js";
import {config} from "/src/states.js";
import {FSE_NotAllowed, FSE_NotFound, FSE_NotSupported, throwDOMException} from "../../common/pure-utils.js";

/**
 *
 * @type {Map<string, {
 *     worker: import("unconscious/common/safe-worker/safe-worker").Sandbox,
 *     workerPermissions: Set<string>,
 *     destroyTimeout: number
 * }>}
 */
const sandboxInstances = new Map;

/**
 * @type {Record<string, function(AiChat.Conversation): Record<string, Function>>}
 */
export const JS_HOST_MODULES = {
	'tools': conv => new Proxy({}, {
		get(target, key) {
			const exist = conv.tools.has(key);
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
	})
};

/**
 * @type {Record<string, { path?: string, url?: string, description: string, k?: string, alias?: string[] }>}
 */
export const JS_SANDBOX_MODULES = {
	'unconscious/common/Json.js': {
		path: "assets/sandbox/Json.js",
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
}`,
		k: "json"
	},
	'base64': {
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
}`,
		k: "base64"
	},
	'unconscious/common/SHA256.js': {
		path: "assets/sandbox/SHA256.js",
		description: `Ultrafast Streaming SHA256 Hasher
export class SHA256 {
    update(data: string | Uint8Array): this;
    digest(format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
    /** alias of digest('hex') */
    toString(): string;
    static hash(data: string | Uint8Array, format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
}}`,
		k: "sha hash"
	},
	'unconscious/common/text-diff.js': {
		path: "assets/sandbox/text-diff.js",
		description: `Myers diff algorithm.
export {
  textDiff(a: string[], b: string[], trimSame = false): {
    type: 'same' | 'add' | 'del',
    oldIndex: number | null,
    newIndex: number | null,
    text: string
  }[]
}`,
		k: "diff"
	},
	'unconscious/common/xml-parser.js': {
		path: "assets/sandbox/xml-parser.js",
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
      html?: boolean = false;
    }
  ): {
    write(chunk: string): void;
    end(): void;
  },
  parseXmlToTree(str: string, options?: {
    // XML Entities
    decodeEntities?: boolean = true;
    html?: boolean = false;
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
\`\`\``,
		k: "xml html"
	},
	jszip: {
		path: "assets/sandbox/JSZip.js",
		description: "JSZip v3 shim\nexport default JSZip;\nexport { crc32(data: Uint8Array): number }",
		k: "archive zip crc compress decompress"
	},
	mathjs: {
		//url: 'https://unpkg.com/mathjs@15.1.0/lib/browser/math.js',
		path: "assets/sandbox/math.js",
		description: "v15.1.0\nexport default math;",
		k: "math compute matrix vector imagine formula"
	},
	papaparse: {
		path: "assets/sandbox/papaparse.min.js",
		description: "v5.0.2",
		k: "office csv"
	},
	dayjs: {
		alias: ['dayjs/locale/zh-cn', 'dayjs/plugin/isLeapYear'],
		//url: 'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js',
		path: "assets/sandbox/dayjs.min.js",
		description: "v1.x\n- builtins: locale/zh-cn, plugin/isLeapYear (DO NOT IMPORT, THEY ARE ALREADY USABLE)",
		k: "date time"
	},
	xlsx: {
		path: "assets/sandbox/xlsx.mini.min.js",
		description: "v0.20.3 (mini, SheetJS)\nexport default XLSX;\n- XLSX.write 类型可用: [array: ArrayBuffer, buffer: Uint8Array, base64, binary]",
		k: "office table excel xlsx"
	},
	'pdf-lib': {
		//url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
		path: "assets/sandbox/pdf-lib.min.cjs",
		description: "v1.17.1\nexport { PDFDocument, rgb, StandardFonts, ... }\n- 无法渲染中文，需要自行提供中文字体",
		k: "office print pdf"
	},
	docx: {
		path: "assets/sandbox/docx.min.mjs",
		description: "v9.7.1\nexport { Document, Paragraph, Table, ... }",
		k: "office document docx wps"
	},
	lamejs: {
		//url: 'https://unpkg.com/lamejs@1.2.1/lame.min.js',
		path: "assets/lame.min.mjs",
		description: "v1.2.1\nexport { Mp3Encoder, WavHeader }",
		k: "lame audio encode mp3"
	},
	pptxgenjs: {
		//url: 'https://cdn.jsdelivr.net/gh/gitbrent/pptxgenjs/dist/pptxgen.min.js',
		path: "assets/sandbox/pptxgen.min.mjs",
		description: "v4.0.1\nexport default pptxgen;\n- 用 addSlide() 而非 addNewSlide()\n- outputType 用 \"arraybuffer\" 或 \"uint8array\"，不能用 \"nodebuffer\"\n- 用 ChartType 而非 Charts",
		k: "office powerpoint pptx"
	},
	'web-audio-engine': {
		path: "assets/sandbox/offline-audio-context.js",
		description: `export { AudioBuffer, AudioParam, OfflineAudioContext, AudioNode, GainNode, OscillatorNode,
  BiquadFilterNode, DelayNode, ConvolverNode, StereoPannerNode, DynamicsCompressorNode,
  AnalyserNode, AudioWorkletNode, AudioWorkletProcessor };
export default OfflineAudioContext;`,
		k: "audio sound oscillator stereo"
	},

};
const aliases = new Set(Object.values(JS_SANDBOX_MODULES).map(k => k.alias).filter(Boolean).flat());

const ESM_CDN = 'https://esm.sh/';

// [ func, in, out ]
const rpcMethods = {
	open: [ (args) => ({ path: args[0], writable: args[1] }), AS_IS ],
	read: [ (args) => ({ path: args[0], noTruncate: true }), AS_IS ],
	write: [ (args) => ({ path: args[0], content: args[1], overwrite: 'force' }) ],
	append: [ (args) => ({ path: args[0], content: args[1], newline: false }) ],
	mkdir: [ (args) => ({ path: args[0], recursive: args[1] }) ],
	delete: [ (args) => ({ path: args[0], ...args[1] }) ],
	list: [ (args) => ({ path: args[0], json: args[1], pattern: args[2] || '*', showHidden: true, exclude: args[3] }), AS_IS ],
	stat: [ (args) => ({ path: args[0] }), AS_IS ],
	truncate: [ (args) => ({ path: args[0], length: args[1] }), AS_IS ],
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

rpcMethods['copy'] = [crossVFSCopyMove, (args) => ({ src: args[0], dest: args[1], move: args[2] || false })];

const readFile = fileAccess("read");
const appendFn = fileAccess("append");

const MAX_OUTPUT_LENGTH = 20000;
const HALF = MAX_OUTPUT_LENGTH / 2;

/**
 * @type {AiChat.FunctionTool}
 */
export const RunJS = {
	name: "RunJS",
	description: `Execute a JavaScript module (ESM) in sandbox.
- ES2023+, top-level await, import, import attributes and dynamic import(), no live bindings.
- Supports CommonJS-style \`module.exports\`. extension must be \`.cjs\`.
- Node.js shim (no require()): Buffer, process, fs, fetch, and modules \`fs/promises\`, \`path\`, \`url\`.
- Globals without import: crypto.subtle, CompressionStream, OffscreenCanvas, FontFace.
- After the module evaluated, the sandbox detaches — MUST await top-level Promises.
- Permissions: "network" for fetch/Websocket, "eval" for Function, wasm and remote import().
- For Uint8Array, use \`fs.writeFile(path, data, { transfer: true })\` (or appendFile) to transfer the buffer ownership for better performance. The returned promise resolves to a new Uint8Array with the same content; the original buffer becomes invalid.`,
	parameters: {
		type: "object",
		properties: {
			/*explanation: {
				type: "string"
			},*/
			path: {
				type: "string",
				description: "Run an existing JavaScript file."
			},
			code: {
				type: "string",
				description: "Inline code. Mutually exclusive with `path`.",
			},
			env: {
				type: "object",
				description: "\"process.env\", use this to pass data globally, 'CWD' key can also be used.",
				additionalProperties: true
			},
			argv: {
				type: "array",
				description: "\"process.argv\" (from index 2), use this to pass data so you don't need to edit JS files repeatedly.",
				items: {
					type: "string"
				}
			},
			/*persist: {
				type: "boolean",
				default: false,
				description: "Cache loaded modules to improve performance."
			},*/
			permissions: {
				type: "array",
				items: {
					enum: ['network', 'eval']
				}
			},
			timeout: {
				type: "integer",
				default: 30,
				maximum: 290,
				description: "(in seconds)"
			}
		}
	},
	title(tc, ctx) {
		const args = getToolParameters(ctx, tc);
		let label = '运行';
		if (args.path) label += ' '+args.path;
		else label += args.explanation ?? `JS代码 (${formatSize(args.code?.length)})`;
		return label;
	},
	renderInput(ctx, box, tc) {
		let {code, ...rest} = getToolParameters(ctx, tc);
		if (code) {
			let start = 1;

			if (Object.keys(rest).length) {
				const lines = inspect(rest).split('\n').map(s=> "// "+s);
				start -= lines.length;
				code = lines.join("\n")+'\n' + code;
			}
			return <HighlightBox start={start} code={code} filename={"js"} />;
		}

		return false;
	},
	interactive(par, conv) {
		return par.permissions?.length ? "secure" : null;
	},

	async script({code, path, env, argv, timeout = 30, permissions, persist, thread, throw: exc }, response, conv) {
		if (null == code) {
			if (null == path) throw 'Neither path nor code is specified';
			path = normalizePath(path).join('/');
		}

		if (path) {
			code = await readFile({
				path,
				noTruncate: true
			}, response, conv);
			if (/^main\(\)/m.test(code)) throw "You must await main(). if main() is not async, change its name.";
		}

		if (null == thread) thread = conv.id;
		const obj = sandboxInstances.get(thread) || {};
		let {worker, workerPermissions, destroyTimeout} = obj;

		clearTimeout(destroyTimeout);
		const stopWorker = (m) => {
			worker.destroy(m);
			sandboxInstances.delete(thread);
		};

		if (!worker || !deepEqual(workerPermissions, permissions || [])) {
			worker?.destroy();

			const hostModules = new Map;
			for (const key in JS_HOST_MODULES) hostModules.set(key, {});

			const handlers = { hostModules };
			const realPermissions = ['fs'];
			if (permissions?.includes('network')) realPermissions.push('net');
			if (permissions?.includes('eval')) realPermissions.push('eval');

			worker = createSandbox(handlers,  realPermissions, { hostModules, name: "Aint-"+thread });
			worker.handlers = handlers;
			workerPermissions = permissions || [];

			obj.workerPermissions = workerPermissions;
			obj.worker = worker;

			sandboxInstances.set(thread, obj);
		}

		// 它的存在不直接告知模型 (PTC)
		const hostModules = worker.handlers.hostModules;
		for (const key in JS_HOST_MODULES) hostModules.set(key, JS_HOST_MODULES[key](conv));

		const hangTimer = setTimeout(() => stopWorker(new DOMException(timeout.toFixed(2)+"s", "TimeoutError")), timeout * 1000);

		worker.handlers.load = (path, systemModule) => {
			if (!systemModule || path.startsWith("~/")) return readFile({
				path,
				noTruncate: true
			}, {}, conv).catch(e => {
				throwDOMException("Failed to fetch module "+inspect(path)+": "+e.message)
			});

			if (aliases.has(path)) {
				worker.handlers.log('[WARN] Builtin module '+path+' is alias, DO NOT IMPORT, THEY ARE ALREADY USABLE.');
				return '';
			}

			const mod = JS_SANDBOX_MODULES[path];
			if (mod) {
				const src = mod.path;
				return fetch(src, {
					referrerPolicy: 'no-referrer',
				}).then(res => {
					const content = res.headers.get('content-type');
					if (!res.ok) throwDOMException('Failed to fetch module '+src+': HTTP '+res.status, FSE_NotFound);
					if (!content?.includes("javascript")) throwDOMException('Failed to fetch module '+src+': illegal content-type '+content, FSE_NotAllowed);
					return res.text();
				});
			}

			return readFile({ path: "node_modules/"+path }, {}, conv).catch(e => {
				// npm 包名: [@scope/]pkg[@version][/subpath]
				if (!/^(?:@[^/\s@]+\/)?[^/\s@]+(?:@[^/\s@]+)?(?:\/[^/\s@]+)*$/.test(path))
					throwDOMException("Failed to fetch module "+inspect(path)+": Not a valid npm package", FSE_NotSupported);

				const url = ESM_CDN + path;

				if (!permissions?.includes('eval'))
					throwDOMException("Failed to fetch module "+inspect(url)+": Requires 'eval' permission.");

				return `export * from ${JSON.stringify(url)};\nexport {default} from ${JSON.stringify(url)};`;
			})
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
			if (import.meta.env.DEV && log === '[DEBUG] [vite] connected.') return;

			const line = log + '\n';
			totalChars += line.length;
			tail += line;

			if (logFile) {
				appendToLogFile(line);
				tail = tail.slice(-HALF);
			} else if (totalChars > MAX_OUTPUT_LENGTH) {
				logFile = './runjs-' + Math.round(Date.now()/1000) + '-' + getRandomString(3) + '.log';

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
			const reset = !persist;
			const secrets = {
				...config.fs_secrets,
				...conv.fs_secrets,
			};

			const secretNames = {};
			for (const key of Object.keys(secrets)) {
				secretNames[key] = `$env:${key}$`;
			}

			await worker.initialize(reset, secrets);
			await worker.execute(
				path,
				code,
				{
					...config.fs_env,
					...conv.fs_env,
					...secretNames,
					...env,
					SCRIPT_TIMEOUT: timeout
				},
				argv
			);

			// TODO 任务管理器
			obj.destroyTimeout = setTimeout(stopWorker, 610000);
		} catch (e) {
			if (exc) throw e;

			err = prettyError(e);
			stopWorker();
		} finally {
			clearTimeout(hangTimer);
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

		return (getLog()+err) || '[No console output] (Hint: Have you awaited top-level Promise?)';
	}
};

/**
 * @type {AiChat.FunctionTool}
 */
export const SearchModules = {
	name: "SearchModules",
	description: `Find RunJS modules. (archive, office, audio, xml, etc.). Search candidates before say no.`,
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
		const entries = Object.entries(JS_SANDBOX_MODULES);
		for (const [key, { k, description }] of entries) {
			if (!kws.length || kws.some(filter => key.includes(filter) || k.includes(filter))) {
				keys.push(key+": "+description);
				if (keys.length >= limit) break;
			}
		}

		if (!keys.length) return `No module found.
Try directly import npm packages:
  import z from "zod@3";  import "lodash/merge";  import {x} from "@scope/pkg";
Remote imports need permissions: ["eval"].`;

		return `Found ${keys.length} modules.
---
`+keys.join("\n\n");
	}
};