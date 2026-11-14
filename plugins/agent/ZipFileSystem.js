/**
 * 只读 Zip 文件系统：把 zip 伪装成只读的 FileSystemDirectoryHandle
 */

import {ZipReader} from "@roj234/jszip/io";
import {FSE_IsDir, FSE_NotAllowed, FSE_NotFound, throwDOMException} from "/common/pure-utils.js";
import {EMPTY, NestedMap} from "unconscious/common/NestedMap.js";

const readOnly = () => throwDOMException("Read-only filesystem", FSE_NotAllowed);
const notFound = name => throwDOMException(`No such file or directory, open ${JSON.stringify(name)}`, FSE_NotFound);
const sorter = new Intl.Collator(undefined, {numeric: true});

class ZipHandle {
	/** @type {import("@roj234/jszip/io").ZipReaderInstance} */
	#archive;
	/** @type {NestedMap} */
	#tree;
	/** @type {import("@roj234/jszip/io").ZipEntry} */
	#node;
	/** @type {string[]} */
	#path;

	/**
	 * @param {import("@roj234/jszip/io").ZipReaderInstance} archive
	 * @param {NestedMap} tree
	 * @param {string[]} parent
	 * @param [node]
	 */
	constructor(archive, tree, parent, node) {
		this.#archive = archive;
		this.#tree = tree;
		this.#path = parent;
		this.#node = node;
	}
	get kind() { return this.#node ? 'file' : 'directory'; }
	get name() { return this.#path.at(-1); }

	async *entries() {
		const keys = this.#path;

		const children = this.#tree.getChildren(keys);
		if (!children?.c) return;

		const data = [];
		for (const [k, child] of children.c) {
			let node;
			const childName = [...keys, k];
			if (child.v !== EMPTY) {
				node = new ZipHandle(this.#archive, this.#tree, childName, child.v);
			} else {
				node = new ZipHandle(this.#archive, this.#tree, childName);
			}

			data.push([k || '_', node]);
		}

		for (const node of data.sort((a, b) => sorter.compare(a[0], b[0]))) yield node;
	}
	[Symbol.asyncIterator]() { return this.entries(); }

	async getFile(metadataOnly) {
		if (metadataOnly) {
			return {
				name: this.name,
				size: this.#node.uncompressedSize,
				lastModified: this.#node.lastModified
			}
		}

		const blob = await this.#archive.get(this.#node);
		return new File([blob], this.name, {lastModified: this.#node.lastModified});
	}

	#child(name, dir, options) {
		const keys = [...this.#path, name];
		const child = this.#tree.getChildren(keys);

		if (!child) {
			if (options?.create) readOnly();
			notFound(name);
		} else {
			if (child.v !== EMPTY && dir !== true) return new ZipHandle(this.#archive, this.#tree, keys, child.v);
			if (child.c !== null && dir !== false) return new ZipHandle(this.#archive, this.#tree, keys);
			throwDOMException(`"${name}" is a ${dir ? 'file' : 'directory'}`, FSE_IsDir);
		}
	}
	getFileHandle(name, options) { return this.#child(name, false, options); }
	getDirectoryHandle(name, options) { return this.#child(name, true, options); }

	async createWritable() { readOnly(); }
	async removeEntry() { readOnly(); }
	//async isSameEntry(other) { return other?.#archive === this.#archive && other?.#node === this.#node; }
}

/**
 * @param {Blob} source
 * @return {Promise<FileSystemDirectoryHandle>}
 */
export async function openZipDirectoryHandle(source) {
	const instance = await ZipReader(source);
	const fileList = new NestedMap();
	for (let [k, v] of instance.entries()) fileList.set(k.split('/'), v);

	return new ZipHandle(instance, fileList, []);
}