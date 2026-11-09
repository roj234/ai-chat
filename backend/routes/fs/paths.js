import {HttpError} from "../../router.js";
import path from "node:path";

/**
 * 路径校验
 * @param {string} relPath
 * @param {RouteContext} ctx
 * @return {string}
 */
export const pathFilter = (relPath, ctx) => {
    if (null == relPath) throw new HttpError(400, "param error");

    const root = ctx.fsRoot;
    const targetPath = path.resolve(root, relPath);
    // allow path like /tmp/... or C:/tmp/
    if (ctx.fsNoShell && !(targetPath+"\\").startsWith(root) && !/^(?:[a-zA-Z]:)?[\\/]tmp(?:\/|$)/.test(targetPath)) {
        throw new HttpError(403, 'Path traversal');
    }
    return targetPath;
};