// jszip shim using zip-io APIs, mock JSZip

import {ZipReader, ZipWriter} from 'unconscious/common/zip-io.js';
import {UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from 'unconscious';
import {base64DecodeToUint8Array} from "unconscious/common/Base64.js";

/**
 *
 * @param {string} type
 * @param {Uint8Array} buf
 * @returns {Promise<Buffer<ArrayBuffer>|*|module:buffer.Blob|Blob|string>}
 */
const typeConvert = async (type, buf) => {
	if (type === 'string' || type === 'text') return UTF8_TEXT_DECODER.decode(buf);
	if (type === 'array' || type === 'uint8array') return buf;
	if (type === 'arraybuffer') {
		const ab = buf.buffer;
		return buf.byteOffset === 0 && buf.byteLength === ab.byteLength ? ab : ab.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	if (type === 'blob')             return new Blob([buf]);
	if (type === 'nodebuffer')       return Buffer.from(buf);
	if (type === 'base64')           return Buffer.from(buf).toString('base64');
	if (type === 'binarystring')     return Buffer.from(buf).toString('binary');
	throw new Error('Unsupported type '+type);
};

class ZipObject {
	/**
	 * @param {string} name
	 * @param {object} opts
	 * @param {boolean} opts.dir
	 * @param {Date}    opts.date
	 * @param {object}  [opts.data]
	 */
	constructor(name, {
		dir = false,
		date = new Date(),
		comment = '',
		data,
		compression = '',

		_reader,
	} = {}) {
		this.name = name;
		this.dir = dir;
		this.date = date;
		if (comment) this.comment = comment;

		this._data = data;
		if (_reader) this._reader = _reader;
		this.options = compression ? { compression } : {};
	}

	/**
	 * Retrieve decompressed content.
	 * @param {"string"|"text"|"uint8array"|"arraybuffer"|"blob"|"nodebuffer"|"base64"|"binarystring"} type
	 */
	async async(type) {
		let raw;
		if (this._reader) {
			raw = await this._reader.get(this.name);
		} else {
			let data = this._data;
			if (data == null) return null;
			if (typeof data === 'string') {
				raw = UTF8_TEXT_ENCODER.encode(data);
			} else if (data instanceof Uint8Array) {
				raw = data;
			} else {
				raw = new Uint8Array(await data.arrayBuffer());
			}
		}

		return typeConvert(type, raw);
	}
}

// ---------------------------------------------------------------------------
// JSZip
// ---------------------------------------------------------------------------
class JSZip {
	/** @type {Record<string, ZipObject>} */
	files = Object.create(null);
	/** @type {string}   path prefix used by sub-folders (e.g. "dir/") */
	_prefix = '';

	// -- helpers ------------------------------------------------------------

	/** Full internal key for a relative name. */
	#key(name) {
		name = name.replace(/\\/g, '/');
		if (this._prefix) return this._prefix + name;
		return name;
	}

	// -- public API ---------------------------------------------------------

	/**
	 * Add or get a file.
	 *
	 * Setter:  zip.file("hello.txt", "Hello World", { date, compression, comment, ... })
	 * Getter:  zip.file("hello.txt")  →  ZipObject
	 *
	 * @param {string} name
	 * @param {string|Uint8Array|ArrayBuffer|Blob} [data]
	 * @param {} [options]
	 * @returns {JSZip|ZipObject}
	 */
	file(name, data, {
		base64 = false,
		date = new Date(),
		compression = null,
		dir = false,
		createFolders = true
	} = {}) {
		if (name instanceof RegExp) return this.filter(_name => name.test(_name));
		let key = this.#key(name);

		// --- GETTER ---
		if (data === undefined) {
			let zo = this.files[key];
			if (zo) return zo;

			if (!key.endsWith('/')) {
				zo = this.files[key+'/'];
				if (zo) return zo;
			}

			// check for implicit directory
			const dirKey = key.endsWith('/') ? key : key + '/';
			for (const k in this.files) {
				if (k.startsWith(dirKey)) {
					return new ZipObject(key, { dir: true, date: new Date() });
				}
			}
			return null;
		}

		let outData;
		if (dir) {
			if (!key.endsWith('/')) key += '/';
		} else {
			if (base64 && typeof data === 'string') outData = base64DecodeToUint8Array(data);
			else if (typeof data === 'string' || data instanceof Blob || data instanceof Uint8Array) outData = data;
			else if (Array.isArray(data) || data instanceof ArrayBuffer) outData = new Uint8Array(data);
			else if (ArrayBuffer.isView(data)) outData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			else throw new Error('Unsupported data type: ' + data);
		}

		if (createFolders) {
			const dirs = key.split('/').filter(Boolean);
			for (let i = 1; i < dirs.length - 1; i++) {
				const dirKey = dirs.slice(0, i).join('/')+'/';
				if (!this.files[dirKey]) {
					this.files[key] = new ZipObject(key, {
						date,
						dir: true,
					});
				}
			}
		}

		this.files[key] = new ZipObject(key, {
			data: outData,
			date,
			dir,
			//comment: '',
			compression,
		});

		return this;
	}

	/**
	 * Create / navigate into a sub-folder.
	 * Returns a new JSZip instance that shares the same file map but prepends the folder path.
	 *
	 * @param {string} name
	 * @returns {JSZip}
	 */
	folder(name) {
		if (name instanceof RegExp) return this.filter(_name => name.test(_name));

		const sub = new JSZip();
		sub.files = this.files;
		sub._prefix = this.#key(name).replace(/\/$/, '') + '/';
		return sub;
	}

	/**
	 * Remove a file or entire folder (all entries with that prefix).
	 * @param {string} name
	 * @returns {JSZip}
	 */
	remove(name) {
		const key = this.#key(name);

		// Remove exact match + everything underneath (folder semantics)
		const prefix = key.endsWith('/') ? key : key + '/';
		for (const k in this.files) {
			if (k === key || k.startsWith(prefix)) {
				delete this.files[k];
			}
		}

		return this;
	}

	/**
	 * Generate the ZIP binary.
	 *
	 * @param {{ type?: "blob"|"uint8array"|"arraybuffer"|"nodebuffer", compression?: "DEFLATE"|"STORE" }} [options]
	 * @returns {Promise<Blob|Uint8Array|ArrayBuffer>}
	 */
	async generateAsync({
		type,
		compression = 'STORE',
		mimeType = 'application/zip'
	} = {}, onUpdate) {
		const writer = ZipWriter();

		let i = 0;
		const entries = Object.entries(this.files);
		let size = entries.length;
		for (const [name, entry] of entries) {
			if (entry.dir) continue;

			let data = entry._data;
			if (data instanceof Blob) {
				data = new Uint8Array(await data.arrayBuffer());
			}

			if (data.lastModified) {
				await writer.add(name, entry._reader, data);
			} else {
				await writer.add(name, data, {
					lastModified: entry.date.getTime(),
					compression: (entry.options.compression || compression) !== 'STORE',
				});
			}

			onUpdate?.(++i / size * 100, name);
		}

		const blob = writer.finish(mimeType);
		if (type === 'blob') return blob;

		const buf = new Uint8Array(await blob.arrayBuffer());
		return typeConvert(type, buf);
	}

	/**
	 * Iterate over every file in the zip (at this prefix level).
	 * Callback receives (relativePath, ZipObject).
	 *
	 * @param {(relativePath: string, file: ZipObject) => void} callback
	 */
	forEach(callback) {
		const prefix = this._prefix;
		const prefixLen = prefix.length;
		const files = this.files;
		for (const fullPath in files) {
			if (!fullPath.startsWith(prefix)) continue;
			callback(fullPath.slice(prefixLen), files[fullPath]);
		}
	}

	/**
	 * Filter files by predicate, return array of ZipObject.
	 * @param {(relativePath: string, file: ZipObject) => boolean} predicate
	 * @returns {ZipObject[]}
	 */
	filter(predicate) {
		const result = [];
		this.forEach((rel, file) => {
			if (predicate(rel, file)) result.push(file);
		});
		return result;
	}

	// -- static -------------------------------------------------------------

	/** @returns {string} */
	static version = '3.10.1-shim';
	static support = {base64:true,array:true,string:true,arraybuffer:true,nodebuffer:true,uint8array:true,blob:true,nodestream:false}

	/**
	 * Load a ZIP from a Blob, Uint8Array, or ArrayBuffer.
	 * @param {Blob|Uint8Array|ArrayBuffer} data
	 * @param {boolean} [checkCRC32]
	 * @returns {Promise<JSZip>}
	 */
	async loadAsync(data, { checkCRC32 = false, base64 = false } = {}) {
		const zip = this;
		if (zip._prefix) throw new Error('JSZip.loadAsync: called on prefix stub');

		data = await data;

		if (base64 && typeof data === 'string') data = base64DecodeToUint8Array(data);

		// Coerce to Blob for ZipReader
		let blob;
		if (data instanceof Blob) {
			blob = data;
		} else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
			blob = new Blob([data]);
		} else {
			throw new Error('JSZip.loadAsync: expected Blob, Uint8Array, or ArrayBuffer');
		}

		const reader = await ZipReader(blob, { verify: checkCRC32 });

		zip.files = Object.create(null);
		for (const [name, entry] of reader.entries()) {
			zip.files[name] = new ZipObject(name, {
				_reader: reader,
				data: entry,
				dir: name.endsWith('/'),
				date: new Date(entry.lastModified),
				compression: entry.method === 0 ? 'STORE' : 'DEFLATE'
			});
		}

		return zip;
	}

	static loadAsync(data, options) {
		return new JSZip().loadAsync(data, options);
	}
}

export default JSZip;