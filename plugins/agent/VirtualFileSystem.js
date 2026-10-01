import {NestedMap, NODE_VALUE} from "unconscious/common/NestedMap.js";
import {FSE_NotFound, FSE_NotSupported, throwDOMException} from "../../common/pure-utils.js";

const SOME = {};

export class VirtualFile {
	get kind() { return 'file'; }

	text;
	constructor(fs, path) {
		this.fs = fs;
		this.path = path;
	}

	async _text() {
		let text = this.text;
		if (text == null) {
			text = this.text = await this.fs.read(this.path);
		}
		return text;
	}

	async createWritable({ keepExistingData } = SOME) {
		let text = keepExistingData ? await this._text() : '';
		return {
			async write(data) {
				if (data instanceof Blob) data = await data.text();
				else if (typeof data !== "string") throwDOMException("Binary is not supported yet", FSE_NotSupported);
				text += data;},
			seek(pos) {throwDOMException("Seek not implemented", FSE_NotSupported);},
			close: async () => {
				await this.fs.write(this.path, text);
				this.text = text;
			}
		}
	}
	async getFile() {
		const text = await this._text()
		const time = Date.now();
		return new File([text], "unknown");
	}
}
export class VirtualDirectory {
	get kind() { return 'directory'; }

	/**
	 *
	 * @param {NestedMap<string, Function>} fs
	 * @param {string[]} path
	 * @param children=
	 */
	constructor(fs, path = ["."], children) {
		this.fs = fs;
		this.path = path;
		this.children = children || fs.getChildren(path);
	}

	async *entries() {
		const children = this.children;
		const hook = children.get(NODE_VALUE);
		if (hook) {
			yield * (await (await (hook.handle || hook)).entries(this));
			return;
		}

		for (let [name, val] of children) {
			const joinedKey = [...this.path, name];
			const hook = val.get(NODE_VALUE);

			yield [name, hook?.read ? new VirtualFile(hook, joinedKey) : new VirtualDirectory(this.fs, joinedKey, val)];
		}
	}
	[Symbol.asyncIterator]() { return this.entries(); }

	async getDirectoryHandle(name, { create } = SOME) {
		const children = this.children;
		const entries = children.get(name);
		let hook;
		if (entries?.size && !(hook = entries.get(NODE_VALUE))?.read) {
			return hook?.handle || new VirtualDirectory(this.fs, [...this.path, name], entries);
		}

		hook = await (children.get(NODE_VALUE)?.dir?.(name, create, this));
		if (hook) return hook;

		const message = (create?"CreateDir ":"ReadDir " )+JSON.stringify([...this.path, name].join('/'));
		throwDOMException(message,create ? FSE_NotSupported : FSE_NotFound);
	}

	async getFileHandle(name, { create } = SOME) {
		const children = this.children;
		const handle = children.get(name)?.get(NODE_VALUE);
		if (handle?.read) {
			return new VirtualFile(handle, [...this.path, name]);
		}

		const hook = await (children.get(NODE_VALUE)?.file?.(name, create, this));
		if (hook) return hook;

		const message = (create?"CreateFile ":"ReadFile " )+JSON.stringify([...this.path, name].join('/'));
		throwDOMException(message,create ? FSE_NotSupported : FSE_NotFound);
	}

	async removeEntry(name, options, { recursive } = SOME) {
		const hook = await (this.children.get(NODE_VALUE)?.del);
		if (hook) return hook(name, recursive, this);

		const message = ("Delete " )+JSON.stringify([...this.path, name].join('/'));
		throwDOMException(message, FSE_NotSupported);
	}
}

/**
 *
 * @type {Record<string, VirtualDirectory>}
 */
export const NAMED_VFS = {
	"": new VirtualDirectory(new NestedMap()) // 空文件系统
};
