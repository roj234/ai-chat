import {createModule} from "unconscious/common/safe-worker/safe-worker.js";
import {testRunner} from "./index.js";

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

const testWorker = (modules, entryKey, testFn) => {
	const sm = createModule(modules, entryKey);
	return sm.ready.then(() => {
		return testFn(sm).finally(() => { sm.destroy(); });
	})
};

// ==========================================================================
// Test 1: Basic Transform — import / export
// ==========================================================================
function testBasicTransform() {
	var modules = new Map();
	modules.set('entry', { code: `
    // import { evil } from "evil";
    /* export function hack() {} */
    import content from 'data.txt' assert { type: 'text' };
    import answer from 'answer';
    import * as math from 'better-math';
    export function getAnswer() { return answer; }
    import { fetchData } from 'host-api';
    export async function getData() {
      const data = await fetchData(content);
      return 'Answer for '+data+' is '+(math?.multiply(answer, 2) / 2 ?? '比比拉布');
    }
  `});
	modules.set('data.txt', { code: 'The life' });
	modules.set('better-math', { code: `export * from 'math';`});
	modules.set('answer', { code: `export default 42;`});
	modules.set('math', { code: `
    export function multiply(a, b) { return a * b; }
    export function divide(a, b) { return a / b; }
  `});
	modules.set('host-api', {
		module: {
			fetchData: id => id+" and universe"
		}
	});
	return testWorker(modules, 'entry', (sm) => {
		return sm.module.getData().then((r) => {
			assert(r === 'Answer for The life and universe is 42', 'got ' + r);
		});
	});
}

// ==========================================================================
// Test 4: Side-effect import
// ==========================================================================
function testSideEffectImport() {
	console.log('\n--- Test 4: Side-effect import ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import 'side-effect';
    export function getValue() {
      return globalThis.__sideEffectValue || 'not set';
    }
  `});
	modules.set('side-effect', { code: `
    globalThis.__sideEffectValue = 'side-effect-run';
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.getValue().then(function (r) {
			assert(r === 'side-effect-run', 'side-effect, got ' + r);
		});
	});
}

// ==========================================================================
// Test 6: Dynamic import() throws (sync)
// ==========================================================================
function testDynamicImportThrows() {
	console.log('\n--- Test 6: Dynamic import() throws ---');
	var modules = new Map();
	modules.set('entry', { code: `
    export function f() { return import('dynamic'); }
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.f().catch(function (r) {
			assert(r.message === 'Module not found: dynamic', 'Should throw module not found');
		});
	});
}

// ==========================================================================
// Test 12: Circular dependency
// ==========================================================================
function testCircularDependency() {
	console.log('\n--- Test 12: Circular dependency ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import { foo } from 'a';
    export function test() { return foo(5); }
  `});
	modules.set('a', { code: `
    import { bar } from 'b';
    export function foo(x) { return bar(x) + 1; }
  `});
	modules.set('b', { code: `
    import { foo } from 'a';
    export function bar(x) { return x * 2; }
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.test().then(function (r) {
			assert(r === 11, 'circular: foo(5)=11, got ' + r);
		});
	});
}

// ==========================================================================
// Test 15: Regex literals containing import-like text
// ==========================================================================
function testRegexLiterals() {
	console.log('\n--- Test 15: Regex literals ---');
	var modules = new Map();
	modules.set('entry', { code: `
    const re = /import.*from.*['"]/;
    import { val } from 'val';
    export function test(str) { return re.test(str) + '-' + val; }
  `});
	modules.set('val', { code: `
    export const val = 99;
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.test('import x from "y"').then(function (r) {
			assert(r === 'true-99', 'regex not confused, got ' + r);
		});
	});
}

// ==========================================================================
// Test 16: export * as ns from
// ==========================================================================
function testExportStarAs() {
	console.log('\n--- Test 16: export * as ns from ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import { base, extra } from 'wrapper';
    export function combined() { return base.fn() + extra.fn(); }
  `});
	modules.set('wrapper', { code: `
    export * as base from 'a';
    export * as extra from 'b';
  `});
	modules.set('a', { code: `
    export function fn() { return 'A'; }
  `});
	modules.set('b', { code: `
    export function fn() { return 'B'; }
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.combined().then(function (r) {
			assert(r === 'AB', 'export * as, got ' + r);
		});
	});
}

// ==========================================================================
// Test 17: import default + named combined
// ==========================================================================
function testDefaultAndNamed() {
	console.log('\n--- Test 17: import default + named ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import def, { a, b } from 'mixed';
    export function all() { return def + '-' + a + '-' + b; }
  `});
	modules.set('mixed', { code: `
    export default 'D';
    export const a = 'A';
    export const b = 'B';
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.all().then(function (r) {
			assert(r === 'D-A-B', 'default+named, got ' + r);
		});
	});
}

// ==========================================================================
// Test 18: Template literal with nested expressions & strings
// ==========================================================================
function testTemplateNesting() {
	console.log('\n--- Test 18: Template literal nesting ---');
	var modules = new Map();
	modules.set('entry', { code:
			'export function tmplTest() {\n' +
			'  const v = `a ${ "}" } b ${ `nested` } c`;\n' +
			'  const importStr = `${ "import" } not parsed`;\n' +
			'  return v + "|" + importStr;\n' +
			'}\n'
	});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.tmplTest().then(function (r) {
			assert(r === 'a } b nested c|import not parsed',
				'template nesting, got ' + r);
		});
	});
}

// ==========================================================================
// Test 21: export {a, b as c}
// ==========================================================================
function testExportNamed() {
	console.log('\n--- Test 21: export {a, b as c} ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import { c, a } from 'lib';
    export function concat() { return a + '-' + c; }
  `});
	modules.set('lib', { code: `
    const a = 'X';
    const b = 'Y';
    export { a, b as c };
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.concat().then(function (r) {
			assert(r === 'X-Y', 'export {a, b as c}, got ' + r);
		});
	});
}

// ==========================================================================
// Test 22: export default anonymous function/class
// ==========================================================================
function testExportDefaultAnonymous() {
	console.log('\n--- Test 22: export default anonymous ---');
	var modules = new Map();
	modules.set('entry', { code: `
    import fn from 'anon-fn';
    import Cls from 'anon-cls';
    export function test() { return fn(3) + '-' + (new Cls()).name; }
  `});
	modules.set('anon-fn', { code: `
    export default function(x) { return x * 2; }
  `});
	modules.set('anon-cls', { code: `
    export default class { constructor() { this.name = 'Hi'; } }
  `});
	return testWorker(modules, 'entry', function (sm) {
		return sm.module.test().then(function (r) {
			assert(r === '6-Hi', 'anon default, got ' + r);
		});
	});
}


var tests = [
	testBasicTransform,
	testSideEffectImport,
	testDynamicImportThrows,
	testCircularDependency,
	testRegexLiterals,
	testExportStarAs,
	testDefaultAndNamed,
	testTemplateNesting,
	testExportNamed,
	testExportDefaultAnonymous,
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