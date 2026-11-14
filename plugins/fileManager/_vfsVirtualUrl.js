import {FS_SOURCE} from "../agent/index.js";

export const SUPPORTED_VFS_KINDS = new Set(['local', 'opfs', 'db', 'api']);

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @return {?string}
 */
export const resolveVirtualUrl = (fs, path) => {
	const sw = navigator.serviceWorker?.controller;
	const mount = fs[FS_SOURCE];
	if (sw && mount && SUPPORTED_VFS_KINDS.has(mount.fs_type)) return "vfs/"+(mount.fs_type+'@'+encodeURIComponent(mount.fs_base||'')+"@"+encodeURIComponent(mount.fs_server||''))+"/"+encodeURIComponent(path).replaceAll("%2F", "/");
}