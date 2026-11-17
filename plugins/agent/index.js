export {fileAccess, createFileSystem, createFileSystemAsync, callFileSystemFunc, getFileSystem, FS_SOURCE, FS_INSTANCE, vfsIdentity} from "./Mounts.js";
export {getChangeableFiles, FileChangerNames} from "./overwrite-monitor.js";

export {VHandle, SimpleDirectory, NAMED_VFS} from "./VirtualFileSystem.js";
export {RunJS, JS_HOST_MODULES, JS_SANDBOX_MODULES} from "./run_js.js";
export {getSkillCache} from "./skills.js";

import {VHandle} from "./VirtualFileSystem.js";
import {createWebFileSystem} from "./WebFSDriver.js";
import {unconscious} from "unconscious";
import {EVENT_BUS, selectedConversation} from "/src/states.js";
import {callFileSystemFunc, FS_SOURCE, getFileSystem} from "./Mounts.js";

/**
 *
 * @param {import("unconscious/common/NestedMap.js").NestedMap} map
 * @param {AiChat.Mount} [options]
 * @return {Promise<AiChat.FileSystemInstance>}
 */
export const createVirtualFileSystem = (map, options) => createWebFileSystem(new VHandle(map), options);

export const SW_VFS_TYPES = new Set(['local', 'opfs', 'db', 'api']);

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @return {?string}
 */
export const resolveVirtualUrl = (fs, path) => {
	const sw = navigator.serviceWorker?.controller;
	const mount = fs[FS_SOURCE];
	if (sw && mount && SW_VFS_TYPES.has(mount.fs_type)) return "vfs/"+(mount.fs_type+'@'+encodeURIComponent(mount.fs_base||'')+"@"+encodeURIComponent(mount.fs_server||''))+"/"+encodeURIComponent(path).replaceAll("%2F", "/");
};

EVENT_BUS.on('resolveUrl', async (path, _, fs) => {
	if (fs == null) {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		[path, fs] = await getFileSystem(path, conv, true);
	}

	const url = new URL(path, 'http://0');
	const realpath = decodeURIComponent(url.pathname.slice(1));
	const fsType = fs[FS_SOURCE].fs_type;
	return (fsType !== 'local' && fsType !== 'opfs' && resolveVirtualUrl(fs, realpath)) || callFileSystemFunc(fs, 'readRaw', { path: realpath });
});