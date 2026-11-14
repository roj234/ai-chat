import {EMPTY, NestedMap} from "unconscious/common/NestedMap.js";
import {FSE_IsDir, FSE_NotAllowed, FSE_NotFound, FSE_NotSupported, throwDOMException} from "/common/pure-utils.js";
import {decodeObjects, serializeJSON} from "/src/utils/serialization.js";
import {parseJson5} from "@roj234/stream-json";

const readOnly = () => throwDOMException("Read-only filesystem", FSE_NotAllowed);
const notFound = name => throwDOMException(`No such file or directory, open ${JSON.stringify(name)}`, FSE_NotFound);
const sorter = new Intl.Collator(undefined, {numeric: true});

export class VHandle {
	/** @type {NestedMap} */
	#tree;
	/** @type {AiChat.VirtualFileHandleHandler | AiChat.VirtualDirectoryHandleHandler | null} */
	#node;
	/** @type {string[]} */
	#path;

	/**
	 * @param {NestedMap} tree
	 * @param {string[]} parent
	 * @param [node]
	 */
	constructor(tree, parent, node) {
		this.#tree = tree;
		this.#path = parent;
		this.#node = node;
	}
	get kind() { return this.#node?.read ? 'file' : 'directory'; }
	get name() { return this.#path.at(-1); }

	async *entries() {
		const keys = this.#path;
		const data = [];

		const hook = this.#node;
		if (hook?.entries) {
			const result = hook.entries(keys);
			for await (const [k, child] of result) {
				const path = [...keys, k];
				const node = new VHandle(this.#tree, path, child);
				data.push([k, node]);
			}
		} else {
			const children = this.#tree.getChildren(keys);
			if (!children?.c) return;

			for (const [k, child] of children.c) {
				const path = [...keys, k];
				const node = child.v !== EMPTY ? new VHandle(this.#tree, path, child.v) : new VHandle(this.#tree, path);
				data.push([k || '_', node]);
			}
		}

		for (const node of data.sort((a, b) => sorter.compare(a[0], b[0]))) yield node;
	}
	[Symbol.asyncIterator]() { return this.entries(); }

	getFile(metadataOnly) {return this.#node.read(metadataOnly, this.#path);}
	async createWritable({ keepExistingData } = {}) {
		const writable = this.#node?.write;
		if (!writable || this.#node.ro) return readOnly();

		const chunks = keepExistingData ? [await this.getFile()] : [];
		return {
			async write(data) {
				if (data instanceof Blob) data = await data.text();
				else if (typeof data !== "string") throwDOMException("Binary is not supported yet", FSE_NotSupported);
				chunks.push(data);
			},
			seek(pos) {throwDOMException("Seek not implemented", FSE_NotSupported);},
			close: () => this.#node.write(chunks, this.#path)
		}
	}

	async #child(name, dir, options) {
		const keys = [...this.#path, name];

		const hook = this.#node;
		if (hook?.child) {
			const result = await hook.child(keys, dir, options?.create, this.#path);
			if (result) return new VHandle(this.#tree, keys, result);
		}

		const child = this.#tree.getChildren(keys);

		if (!child) {
			if (options?.create) readOnly();
			notFound(name);
		} else {
			if (child.c !== null && dir !== false) return new VHandle(this.#tree, keys);
			if (child.v) {
				const isFile = child.v.read;
				if (isFile ? (dir !== true) : (dir !== false))
					return new VHandle(this.#tree, keys, child.v);
			}
			throwDOMException(`"${name}" is a ${dir ? 'file' : 'directory'}`, FSE_IsDir);
		}
	}
	getFileHandle(name, options) { return this.#child(name, false, options); }
	getDirectoryHandle(name, options) { return this.#child(name, true, options); }

	async removeEntry(name, opt) {
		const hook = this.#node?.rm;
		if (!hook) return readOnly(this.#path);
		return hook(name, opt?.recursive, this.#path);
	}
	//async isSameEntry(other) { return other?.#archive === this.#archive && other?.#node === this.#node; }
}

/**
 * @type {AiChat.VirtualDirectoryHandleHandler}
 */
export class SimpleDirectory {
	#dirs = new Map;
	#files = new Map;

	add(name, handler) {
		(handler.read ? this.#files : this.#dirs).set(name, handler);
		return this;
	}
	child(name, dir) {
		return (!dir ? this.#files : this.#dirs).get(name.at(-1));
	}
	*entries() {
		yield * this.#dirs;
		yield * this.#files;
	}
}

/**
 * @param meta
 * @param read
 * @param write
 * @return {AiChat.VirtualFileHandleHandler}
 */
export const JsonFile = ({meta, read, write}) => {
	return {
		async read(metadataOnly, path) {
			const [time, data] = await meta(path);
			const bag = { lastModified: time ?? Date.now(), size: -1 };
			if (metadataOnly) return bag;
			const obj = read ? await read(data, path) : data;
			return new File(obj === undefined ? [] : [await serializeJSON(obj, 2)], path.at(-1), bag);
		},
		ro: !write,
		async write(data, path) {
			const text = data.every(s => typeof s === 'string') ? data.join('') : await new Blob(data).text();
			return write(await decodeObjects(parseJson5(text)), path);
		},
	};
}

/**
 * @type {Record<string, VHandle>}
 */
export const NAMED_VFS = {
	"": new VHandle(new NestedMap(), []) // 空文件系统
};
