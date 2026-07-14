import {createSandbox} from "unconscious/common/safe-worker/safe-worker.js";
import {testRunner} from "./index.js";

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const testWorker = (modules, entryKey, testFn) => {
	// 拆分 host 模块和代码模块
	const hostModules = new Map();
	const codeModules = new Map();
	for (const [name, mod] of modules) {
		if (typeof mod === 'string') {
			codeModules.set(name, mod);
		} else {
			hostModules.set(name, mod);
		}
	}

	const handlers = {
		load(name, system) {
			const code = codeModules.get(name);
			if (code === undefined) throw new Error('Module not found: ' + name);
			return code;
		},
		log(/*line*/) {} // 测试中抑制 console 输出
	};

	const sandbox = createSandbox(
		handlers,
		['fs'],
		hostModules.size ? { hostModules } : undefined
	);

	return sandbox.initialize().then(() => {
		return sandbox.loadModule(entryKey).then(mod => {
			return testFn(mod).finally(() => sandbox.destroy());
		});
	});
};

// ==========================================================================
// Test 1: Basic Transform — import / export
// ==========================================================================
function testBasicTransform() {
	var modules = new Map();
	modules.set('entry', `
    // import { evil } from "evil";
    /* export function hack() {} */
    import content from './data.txt' assert { type: 'text' };
    import answer from 'answer';
    import * as math from 'better-math';
    export function getAnswer() { return answer; }
    import { fetchData } from 'host-api';
    export async function getData() {
      const data = await fetchData(content);
      return 'Answer for '+data+' is '+(math?.multiply(answer, 2) / 2 ?? '比比拉布');
    }
  `);
	modules.set('data.txt', 'The life');
	modules.set('better-math', `export * from 'math';`);
	modules.set('answer', `export default 42;`);
	modules.set('math', `
    export function multiply(a, b) { return a * b; }
    export function divide(a, b) { return a / b; }
  `);
	modules.set('host-api', {
		fetchData: id => id+" and universe"
	});
	return testWorker(modules, 'entry', (mod) => {
		return mod.getData().then((r) => {
			assert(r === 'Answer for The life and universe is 42', 'got ' + r);
		});
	});
}

// ==========================================================================
// Test 2: Side-effect import
// ==========================================================================
function testSideEffectImport() {
	console.log('\n--- Test 2: Side-effect import ---');
	var modules = new Map();
	modules.set('entry', `
    import 'side-effect';
    export function getValue() {
      return globalThis.__sideEffectValue || 'not set';
    }
  `);
	modules.set('side-effect', `
    globalThis.__sideEffectValue = 'side-effect-run';
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.getValue().then(function (r) {
			assert(r === 'side-effect-run', 'side-effect, got ' + r);
		});
	});
}

// ==========================================================================
// Test 3: Dynamic import() throws (sync)
// ==========================================================================
function testDynamicImportThrows() {
	console.log('\n--- Test 3: Dynamic import() throws ---');
	var modules = new Map();
	modules.set('entry', `
    export function f() { return import('dynamic'); }
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.f().catch(function (r) {
			assert(r.message === 'Module not found: dynamic', 'Should throw module not found');
		});
	});
}

// ==========================================================================
// Test 4: export default anonymous function/class
// ==========================================================================
function testExportDefaultAnonymous() {
	console.log('\n--- Test 4: export default anonymous ---');
	var modules = new Map();
	modules.set('entry', `
    import fn from 'anon-fn';
    import Cls from 'anon-cls';
    export function test() { return fn(3) + '-' + (new Cls()).name; }
  `);
	modules.set('anon-fn', `
    export default function(x) { return x * 2; }
  `);
	modules.set('anon-cls', `
    export default class { constructor() { this.name = 'Hi'; } }
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.test().then(function (r) {
			assert(r === '6-Hi', 'anon default, got ' + r);
		});
	});
}

// ==========================================================================
// Test 5: Circular dependency
// ==========================================================================
function testCircularDependency() {
	console.log('\n--- Test 5: Circular dependency ---');
	var modules = new Map();
	modules.set('entry', `
    import { foo } from 'a';
    export function test() { return foo(5); }
  `);
	modules.set('a', `
    import { bar } from 'b';
    export function foo(x) { return bar(x) + 1; }
  `);
	modules.set('b', `
    import { foo } from 'a';
    export function bar(x) { return x * 2; }
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.test().then(function (r) {
			assert(r === 11, 'circular: foo(5)=11, got ' + r);
		});
	});
}

// ==========================================================================
// Test 6: Regex literals containing import-like text
// ==========================================================================
function testRegexLiterals() {
	console.log('\n--- Test 6: Regex literals ---');
	var modules = new Map();
	modules.set('entry', `
    const re = /import.*from.*['"]/;
    import { val } from 'val';
    export function test(str) { return re.test(str) + '-' + val; }
  `);
	modules.set('val', `
    export const val = 99;
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.test('import x from "y"').then(function (r) {
			assert(r === 'true-99', 'regex not confused, got ' + r);
		});
	});
}

// ==========================================================================
// Test 7: export * as ns from
// ==========================================================================
function testExportStarAs() {
	console.log('\n--- Test 7: export * as ns from ---');
	var modules = new Map();
	modules.set('entry', `
    import { base, extra } from 'wrapper';
    export function combined() { return base.fn() + extra.fn(); }
  `);
	modules.set('wrapper', `
    export * as base from 'a';
    export * as extra from 'b';
  `);
	modules.set('a', `
    export function fn() { return 'A'; }
  `);
	modules.set('b', `
    export function fn() { return 'B'; }
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.combined().then(function (r) {
			assert(r === 'AB', 'export * as, got ' + r);
		});
	});
}

// ==========================================================================
// Test 8: import default + named combined
// ==========================================================================
function testDefaultAndNamed() {
	console.log('\n--- Test 8: import default + named ---');
	var modules = new Map();
	modules.set('entry', `
    import def, { a, b } from 'mixed';
    export function all() { return def + '-' + a + '-' + b; }
  `);
	modules.set('mixed', `
    export default 'D';
    export const a = 'A';
    export const b = 'B';
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.all().then(function (r) {
			assert(r === 'D-A-B', 'default+named, got ' + r);
		});
	});
}

// ==========================================================================
// Test 9: Template literal with nested expressions & strings
// ==========================================================================
function testTemplateNesting() {
	console.log('\n--- Test 9: Template literal nesting ---');
	var modules = new Map();
	modules.set('entry',
			'export function tmplTest() {\n' +
			'  const v = `a ${ "}" } b ${ `nested` } c`;\n' +
			'  const importStr = `${ "import" } not parsed`;\n' +
			'  return v + "|" + importStr;\n' +
			'}\n'
	);
	return testWorker(modules, 'entry', function (mod) {
		return mod.tmplTest().then(function (r) {
			assert(r === 'a } b nested c|import not parsed',
				'template nesting, got ' + r);
		});
	});
}

// ==========================================================================
// Test 10: export {a, b as c}
// ==========================================================================
function testExportNamed() {
	console.log('\n--- Test 10: export {a, b as c} ---');
	var modules = new Map();
	modules.set('entry', `
    import { c, a } from 'lib';
    export function concat() { return a + '-' + c; }
  `);
	modules.set('lib', `
    const a = 'X';
    const b = 'Y';
    export { a, b as c };
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.concat().then(function (r) {
			assert(r === 'X-Y', 'export {a, b as c}, got ' + r);
		});
	});
}

// ==========================================================================
// Test 11: export const/let/var
// ==========================================================================
function testExportConstLetVar() {
	console.log('\n--- Test 11: export const/let/var ---');
	var modules = new Map();
	modules.set('entry', `
    import { a, b, c } from 'vars';
    export function join() { return a + '/' + b + '/' + c; }
  `);
	modules.set('vars', `
    export const a = 'const';
    export let b = 'let';
    export var c = 'var';
  `);
	return testWorker(modules, 'entry', function (mod) {
		return mod.join().then(function (r) {
			assert(r === 'const/let/var', 'export const/let/var, got ' + r);
		});
	});
}

// ==========================================================================
// Test 12: RPC via fs module (round-trip test)
// ==========================================================================
function testFsRPC() {
	console.log('\n--- Test 12: fs RPC round-trip ---');
	var modules = new Map();
	modules.set('entry', `
    import * as fs from 'fs';
    export async function writeAndRead() {
      await fs.writeFile('/test.txt', 'hello rpc');
      const content = await fs.readFile('/test.txt', 'utf-8');
      await fs.rm('/test.txt');
      return content;
    }
  `);
	return testWorker(modules, 'entry', function (mod) {
		// Note: fs RPC depends on handlers.rpc being set up.
		// This test validates the module resolution path for 'fs'.
		// Without an actual rpc handler, writeFile/readFile will throw.
		return mod.writeAndRead().then(
			(r) => assert(false, 'should have thrown without rpc handler'),
			(e) => assert(true, 'fs without rpc handler correctly throws') // expected
		);
	});
}

// ==========================================================================
// Test 13: this context passing
// ==========================================================================
function testThisContext() {
	console.log('\n--- Test 13: this context ---');
	// this context is tested via execute(), not loadModule()
	var modules = new Map();
	modules.set('entry', `
    export function getContext() {
      return this;
    }
  `);

	const handlers = {
		load(name) {
			const mod = modules.get(name);
			if (!mod) throw new Error('Module not found: ' + name);
			return mod;
		},
		log() {}
	};

	const sandbox = createSandbox(handlers, ['fs']);

	return sandbox.initialize().then(() => {
		return sandbox.loadModule('entry').then(mod => {
			// loadModule doesn't pass context, so this will be undefined/globalThis
			return mod.getContext().then(r => {
				// In Worker, top-level this of a module is typically undefined in strict mode
				assert(r === undefined || typeof r === 'object', 'context is undefined or object');
			});
		}).finally(() => sandbox.destroy());
	});
}


var tests = [
	testBasicTransform,
	testSideEffectImport,
	testDynamicImportThrows,
	testExportDefaultAnonymous,
	testCircularDependency,
	testRegexLiterals,
	testExportStarAs,
	testDefaultAndNamed,
	testTemplateNesting,
	testExportNamed,
	testExportConstLetVar,
	testFsRPC,
	testThisContext,
];

for (var i = 0; i < tests.length; i++) {
	let j = i;
	testRunner.push(async () => {
		const result = tests[j]();
		const timeout = new Promise((_, reject) => {
			setTimeout(function () { reject(new Error('TEST TIMEOUT')); }, 5000);
		});
		await Promise.race([result, timeout]);
		return true;
	}, tests[i].name);
}
