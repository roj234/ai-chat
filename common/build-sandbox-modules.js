import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build as esbuildBuild} from 'esbuild';


export const SANDBOX_MODULES = [
	'@roj234/stream-json',
	'./common/comfy.js',
	'unconscious/common/SHA256.js',
	'unconscious/common/text-diff.js',
	'unconscious/common/xml-parser.js',
	'@roj234/jszip',
	'@roj234/web-audio-engine',
];

const SANDBOX_BUILTINS = [
	'buffer', 'fs', 'fs/promises', 'path', 'process', 'url', 'util', 'node:*',
	'@roj234/shared/base64'
];

const buildOne = async (req, root, specifier) => {
	const entry = req.resolve(specifier);
	const x = path.extname(specifier);
	const outFile = path.join(root, 'public', 'assets', 'sandbox', path.basename(x ? specifier.slice(0, -x.length) : specifier)+".js");

	const renamer = {
		name: 'renamer',
		setup(build) {
			build.onResolve({ filter: /^@roj234\/util-inspect$/ }, () => ({
				path: 'util',
				external: true, // 不打包,保留为外部引用
			}))
			build.onResolve({ filter: /^\/.*/ }, (p) => ({
				path: path.join(path.resolve('.'), p.path),
			}))
		},
	}

	const {outputFiles} = await esbuildBuild({
		define: {
			'import.meta.env.DEV': 'false',
			'import.meta.env.PROD': 'true',
			'import.meta.env.MODE': '"production"',
			'process.env.NODE_ENV': '"production"',
			'IS_ANDROID_BUILD': 'false'
		},
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		charset: 'utf8',
		legalComments: 'none',
		plugins: [renamer],
		external: SANDBOX_BUILTINS,
	});

	const code = outputFiles[0].text;
	if (await fs.readFile(outFile, 'utf-8').catch(() => null) === code) return;

	await fs.mkdir(path.dirname(outFile), {recursive: true});
	await fs.writeFile(outFile, code);
	console.log(`[sandbox-modules] ${specifier} -> ${path.relative(root, outFile)} (${(code.length/1024).toFixed(1)} KB)`);
};

/**
 * @param {string} [root] 项目根目录
 */
export function sandboxModules(root = process.cwd()) {
	let built;
	const buildAll = () => built ||= (async () => {
		const req = createRequire(path.join(root, 'package.json'));
		await Promise.all(SANDBOX_MODULES.map(specifier => buildOne(req, root, specifier)));
	})();

	return {
		name: 'aint-sandbox-modules',
		configResolved: buildAll,
		buildStart: buildAll,
	};
}
