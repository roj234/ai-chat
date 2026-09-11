export {createFileSystemAsync} from "./Mounts.js";
export {fileAccess, createFileSystem, FS_INSTANCE} from "./Mounts.js";
export {getChangeableFiles, FileChangerNames} from "./overwrite-monitor.js";

export {VirtualDirectory, VirtualFile, NAMED_VFS} from "./VirtualFileSystem.js";
export {RunJS, JS_HOST_MODULES, JS_SANDBOX_MODULES} from "./run_js.js";
export {getSkillCache} from "./skills.js";

import {VirtualDirectory} from "./VirtualFileSystem.js";
import {createWebFileSystem} from "./WebFSDriver.js";

/**
 *
 * @param {import("unconscious/common/NestedMap.js").NestedMap} map
 * @param {AiChat.Mount} [options]
 * @return {Promise<AiChat.FileSystemInstance>}
 */
export const createVirtualFileSystem = (map, options) => createWebFileSystem(new VirtualDirectory(map), options);