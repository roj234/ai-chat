import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build as esbuildBuild} from 'esbuild';


export const SANDBOX_MODULES = [
	'unconscious/common/Json.js',
	'unconscious/common/SHA256.js',
	'unconscious/common/text-diff.js',
	'unconscious/common/xml-parser.js',
	'unconscious/common/JSZip.js',
	'unconscious/common/web-audio-engine/offline-audio-context.js',
];

const SANDBOX_BUILTINS = [
	'base64', 'buffer', 'fs', 'fs/promises', 'path', 'process', 'url', 'util', 'node:*',
];

const buildOne = async (req, root, specifier) => {
	const entry = req.resolve(specifier);
	const outFile = path.join(root, 'public', 'assets', 'sandbox', path.basename(entry));

	const {outputFiles} = await esbuildBuild({
		define: {
			'import.meta.env.DEV': 'false',
			'import.meta.env.PROD': 'true',
			'import.meta.env.MODE': '"production"',
			'process.env.NODE_ENV': '"production"'
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
