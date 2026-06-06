import {rollup} from 'rollup';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'path';
import {fileURLToPath} from 'url';
import serverPackageInfo from './backend/package.json' with {type: 'json'};
import {configProxy, nodeResolve} from 'unconscious/vite/build-backend.js';

const execFilePromise = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverAbsPath = path.resolve(__dirname, 'dist/server.js');

const rollupConfig = {
	input: 'backend/server.js',
	external: [
		...Object.keys(serverPackageInfo.dependencies || {}),
	],
	plugins: [
		nodeResolve(),
		configProxy({
			include: /[\\/]config\.js$/
		}),
		{
			name: 'my-plugin',
			/**
			 *
			 * @param {string} code
			 * @param {string} id
			 * @return {Promise<{code: string, map: null}>}
			 */
			async transform(code, id) {
				if (!/[\\/]server\.js$/.test(id)) return;

				code = code.replaceAll("{{BUILD_TIME}}", new Date().toISOString());
				code = code.replaceAll("{{PROJECT_VERSION}}", serverPackageInfo.version);

				try {
					const result = await execFilePromise("git", "describe --tags --abbrev=7 --dirty=* --always".split(" "));
					code = code.replaceAll("{{GIT_COMMIT}}", result.stdout.trim());
				} catch {}

				return { code, map: null };
			}
		}
	],
};

const bundle = await rollup(rollupConfig);
await bundle.write({
	file: serverAbsPath,
	format: 'esm',
	//compact: true,
});
console.log("Server built: ", serverAbsPath);