/**
 *
 * @param {object} target
 * @param {Set<string|symbol>} restriction=
 * @return {{proxy: object, shadow: {}}}
 */
function createShadowProxy(target, restriction) {
	const shadow = {};
	const proxy = new Proxy(target, {
		get(target, prop) {
			if (prop in shadow && (!restriction || restriction.has(prop))) {
				return shadow[prop];
			}

			return target[prop];
		},
		set(target, prop, value) {
			shadow[prop] = value;
			return true;
		},
		defineProperty(target, property, attributes) {
			return Object.defineProperty(shadow, property, attributes);
		},
		delete(target, prop) {
			return delete shadow[prop];
		}
	});

	return {
		shadow,
		proxy
	};
}

const SAFE_SET = new Set([
	"Object",
	"Function",
	"Array",
	"Number",
	"parseFloat",
	"parseInt",
	"Infinity",
	"NaN",
	"undefined",
	"Boolean",
	"String",
	"Symbol",
	"Date",
	"Promise",
	"RegExp",
	"Error",
	"AggregateError",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"globalThis",
	"JSON",
	"Math",
	"Intl",
	"ArrayBuffer",
	"Atomics",
	"Uint8Array",
	"Int8Array",
	"Uint16Array",
	"Int16Array",
	"Uint32Array",
	"Int32Array",
	"Float32Array",
	"Float64Array",
	"Uint8ClampedArray",
	"BigUint64Array",
	"BigInt64Array",
	"DataView",
	"Map",
	"BigInt",
	"Set",
	"WeakMap",
	"WeakSet",
	"Proxy",
	"Reflect",
	"FinalizationRegistry",
	"WeakRef",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	"isFinite",
	"isNaN",
	"console",
	"XMLHttpRequestUpload",
	"XMLHttpRequestEventTarget",
	"XMLHttpRequest",
	"WritableStreamDefaultWriter",
	"WritableStreamDefaultController",
	"WritableStream",
	"URLSearchParams",
	"URLPattern",
	"URL",
	"TrustedTypePolicyFactory",
	"TrustedTypePolicy",
	"TrustedScriptURL",
	"TrustedScript",
	"TrustedHTML",
	"TransformStreamDefaultController",
	"TransformStream",
	"TextMetrics",
	"TextEncoderStream",
	"TextEncoder",
	"TextDecoderStream",
	"TextDecoder",
	"TaskSignal",
	"TaskPriorityChangeEvent",
	"TaskController",
	"SyncManager",
	"SourceBufferList",
	"SourceBuffer",
	"SecurityPolicyViolationEvent",
	"Scheduler",
	"Response",
	"Request",
	"ReportingObserver",
	"ReadableStreamDefaultReader",
	"ReadableStreamDefaultController",
	"ReadableStreamBYOBRequest",
	"ReadableStreamBYOBReader",
	"ReadableStream",
	"ReadableByteStreamController",
	"PromiseRejectionEvent",
	"ProgressEvent",
	"Path2D",
	"OffscreenCanvasRenderingContext2D",
	"OffscreenCanvas",
	"ImageData",
	"ImageBitmapRenderingContext",
	"ImageBitmap",
	"Headers",
	"FormData",
	"EventTarget",
	"EventSource",
	"Event",
	"ErrorEvent",
	"CustomEvent",
	"Crypto",
	"Blob",
	"AbortSignal",
	"AbortController",
	"cancelAnimationFrame",
	"requestAnimationFrame",
	"Iterator",
	"CryptoKey",
	"Lock",
	"LockManager",
	"SubtleCrypto"
]);

self.console = {
	log: (s) => {
		postMessage.call(self, {log: s});
	}
};

const postMessage = self.postMessage;
self.onmessage = function(e) {
	try {
		const fn = new Function(e.data);
		const result = fn();
		postMessage.call(self, {result});
	} catch (e) {
		postMessage.call(self, {
			detail: e.message,
			error: e.name
		});
	}
};

const bye = { value: undefined, configure: false };
for (const name of Object.getOwnPropertyNames(self)) {
	if (!SAFE_SET.has(name)) {
		Object.defineProperty(self, name, bye);
	}
}
Object.defineProperty(self, "indexedDB", bye);
Object.defineProperty(self, "cache", bye);