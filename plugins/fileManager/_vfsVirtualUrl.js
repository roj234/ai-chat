import {FS_SOURCE} from "../agent/index.js";

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @return {?string}
 */
export const resolveVirtualUrl = (fs, path) => {
	const sw = navigator.serviceWorker?.controller;
	const mount = fs[FS_SOURCE];
	if (sw && mount) return "vfs/"+(mount.fs_type+'@'+encodeURIComponent(mount.fs_base)+"@"+encodeURIComponent(mount.fs_server))+"/"+encodeURIComponent(path).replaceAll("%2F", "/");
}