import esbuild from 'esbuild';
import path from 'path';
import {fileURLToPath} from 'url';
import fs from "fs";

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import serverPackageInfo from "./backend/package.json" with {type: "json"}

const execFilePromise = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configAbsPath = path.resolve(__dirname, 'backend/config.js');
const serverAbsPath = path.resolve(__dirname, 'dist/server.js');

esbuild.build({
	entryPoints: ['backend/server.js'],
	bundle: true,
	platform: 'node',
	target: 'node22',
	outfile: serverAbsPath,
	format: "esm",
	charset: 'utf8',
	external: [
		...Object.keys(serverPackageInfo.dependencies || {})
	],
	plugins: [
		{
			name: 'config-handle',
			setup(build) {
				// 拦截所有解析请求
				build.onResolve({ filter: /.*config\.js$/ }, (args) => {
					const resolvedPath = path.resolve(args.resolveDir, args.path);
					if (resolvedPath === configAbsPath) {
						return {
							path: './config.js',
							external: true,
						};
					}
				});

				build.onEnd(async _ => {
					let s = fs.readFileSync(serverAbsPath, "utf8");
					s = s.replaceAll("{{BUILD_TIME}}", new Date().toISOString());
					s = s.replaceAll("{{PROJECT_VERSION}}", serverPackageInfo.version);

					try {
						const result = await execFilePromise("git", "describe --tags --abbrev=7 --dirty=* --always".split(" "));
						s = s.replaceAll("{{GIT_COMMIT}}", result.stdout.trim());
					} catch {}

					fs.writeFileSync(serverAbsPath, s);
				})
			}
		}
	]
}).then(() => {
	console.log("Server built: ", serverAbsPath);
});