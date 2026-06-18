import {rollup} from 'rollup';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'path';
import {fileURLToPath} from 'url';
import serverPackageInfo from './backend/package.json' with {type: 'json'};
import clientPackageInfo from './package.json' with {type: 'json'};
import {configProxy, makeBrotliZip, nodeResolve} from 'unconscious/vite/build-backend.js';
import {ZipWriter} from "unconscious/common/zip-io.js";
import fs from "node:fs/promises";

const execFilePromise = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, 'dist');
const serverAbsPath = path.resolve(__dirname, 'dist/server.js');
let commitNumber = 'unknown';

try {
	const result = await execFilePromise("git", "describe --tags --abbrev=7 --dirty=* --always".split(" "));
	commitNumber = result.stdout.trim();
} catch {}


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
				code = code.replaceAll("{{GIT_COMMIT}}", commitNumber);

				return { code, map: null };
			}
		}
	],
};

async function createZip(algorithm, name) {
	const zw = ZipWriter();
	await zw.add("/INFO", JSON.stringify({
		v: clientPackageInfo.version,
		b: process.env.BUILD_NUMBER,
		t: Date.now()
	}));
	const filter = (path) => {
		if (path === 'server.js') return;
		if (path.startsWith('dist.')) return;
		if (path.endsWith(".woff2") || path.endsWith(".webp") || path.endsWith(".png")) return 0;
		return algorithm;
	};
	await makeBrotliZip(zw, distPath, filter);
	await makeBrotliZip(zw, path.resolve(__dirname, 'public'), filter);
	await makeBrotliZip(zw, path.resolve(__dirname, "misc/pwa-config"), filter);

	const blob = await zw.finish().bytes();
	await fs.writeFile(path.join(distPath, name), blob);
}

async function buildServer() {
	const bundle = await rollup(rollupConfig);
	await bundle.write({
		file: serverAbsPath,
		format: 'esm',
		//compact: true,
	});
	console.log("Server built: ", serverAbsPath);
}

await Promise.all([
	createZip(92, "dist.brip"),
	createZip(8, "dist.zip"),
	buildServer()
])
