import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from "node:url";

const scriptPath = pkg => path.dirname(fileURLToPath(new URL(import.meta.resolve(pkg+"/package.json"))));
const pkgDir = scriptPath("highlight.js");

const KEEP_TOP = new Set(['types', 'package.json', 'LICENSE']);
const KEEP_LIB = /^(core|index|common)\.(d\.ts|js)$/;

const rm = (p) => {
	console.log("delete", p);
	fs.rmSync(p, {recursive: true, force: true});
}

for (const name of fs.readdirSync(pkgDir)) {
	if (KEEP_TOP.has(name)) continue;
	let full = path.join(pkgDir, name);

	if (name === 'es') {
		full += '/languages';
		for (const name of fs.readdirSync(full)) {
			if (name.endsWith('.js.js')) rm(path.join(full, name));
		}
	} else if (name === 'lib') {
		for (const sub of fs.readdirSync(full)) {
			if (KEEP_LIB.test(sub)) continue;
			rm(path.join(full, sub));
		}
	} else {
		rm(full);
	}
}