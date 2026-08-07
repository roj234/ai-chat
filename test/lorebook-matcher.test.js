/**
 * LorebookMatcher 测试定义（纯数据，无 UI 依赖）。
 *
 * - 浏览器测试套件：test/lorebook-matcher.test.js 将本文件中的用例推入 testRunner。
 * - 沙箱/Node：可直接导入本文件并用任意迷你 runner 执行，
 *   每个用例是一个 [fn, name]，fn 返回 true 表示通过，否则抛异常。
 */
import {LorebookMatcher} from "../plugins/rp_basic/LorebookMatcher.js";
import {testRunner} from "./index.js";

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

/** 构造一个默认启用的世界书页面 */
const page = (o = {}) => ({ enabled: true, content: "", triggers: [], ...o });

/** 构造一条输入消息 */
const msg = content => ({ content });

/** 提取匹配结果页面名，逗号拼接 */
const names = list => list.map(p => p.name).join(",");

export const lorebookMatcherTests = [
	// ==========================================================================
	// 构造函数
	// ==========================================================================
	[() => {
		let threw = false;
		try {
			new LorebookMatcher([page({ triggers: ["x"], recursion: "bogus" })]);
		} catch (e) {
			threw = e instanceof TypeError;
		}
		assert(threw, "非法的 recursion 值应当抛出 TypeError");
		return true;
	}, "constructor: 非法 recursion 抛 TypeError"],

	[() => {
		let threw = false;
		try {
			new LorebookMatcher([page({ triggers: [] })]);
		} catch (e) {
			threw = e instanceof TypeError;
		}
		assert(threw, "非 constant 页面缺少 triggers 应当抛出 TypeError");
		return true;
	}, "constructor: 无 triggers 的非 constant 页面抛 TypeError"],

	[() => {
		const m = new LorebookMatcher([]);
		assert(m.match([msg("anything")]).length === 0, "空页面数组 match 应返回空数组");
		return true;
	}, "constructor: 空页面数组可用"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "on", triggers: ["cat"] }),
			page({ name: "off", triggers: ["dog"], enabled: false }),
		]);
		assert(names(m.match([msg("cat")])) === "on", "disabled 页面不应被匹配");
		assert(names(m.match([msg("dog")])) === "", "disabled 页面即使命中触发词也不应激活");
		return true;
	}, "constructor: disabled 页面被忽略"],

	[() => {
		const m = new LorebookMatcher([page({ name: "C", constant: true })]);
		assert(names(m.match([msg("x")])) === "C", "constant 页面无需 triggers");
		return true;
	}, "constructor: constant 页面无需 triggers"],

	// ==========================================================================
	// 基础匹配
	// ==========================================================================
	[() => {
		const m = new LorebookMatcher([page({ name: "A", triggers: ["cat", "dOg", "d.er"] })]);
		assert(names(m.match([msg("a cat")])) === "A", "触发词 cat 命中");
		assert(names(m.match([msg("a dog")])) === "A", "触发词 dog 命中");
		assert(names(m.match([msg("a deer")])) !== "A", "触发词 deer 未命中");
		return true;
	}, "match: 基础触发词"],

	[() => {
		const m = new LorebookMatcher([page({ name: "A", triggers: ["a.c"], regex: true })]);
		assert(names(m.match([msg("abc")])) === "A", "触发词按正则源处理");
		return true;
	}, "match: 触发词按正则处理"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "B", triggers: ["beta"] }),
			page({ name: "A", triggers: ["alpha"] }),
		]);
		assert(names(m.match([msg("alpha beta")])) === "B,A", "结果应按原始顺序排序");
		return true;
	}, "match: 结果按页面顺序排序"],

	// ==========================================================================
	// constant 页面
	// ==========================================================================
	[() => {
		const m = new LorebookMatcher([
			page({ name: "C", constant: true }),
			page({ name: "A", triggers: ["cat"] }),
		]);
		assert(names(m.match([])) === "C", "空输入也返回 constant 页面");
		assert(names(m.match([msg("cat")])) === "C,A", "constant 与普通页面并存且参与排序");
		return true;
	}, "constant: 始终激活并参与排序"],

	// ==========================================================================
	// 滑动窗口
	// ==========================================================================
	[() => {
		const m = new LorebookMatcher([page({ name: "W", triggers: ["cat"], window: 2 })]);
		assert(names(m.match([msg("cat")])) === "W", "第 1 条命中即激活");
		assert(names(m.match([msg("cat"), msg("dog")])) === "W", "第 2 条仍在窗口内");
		assert(m.match([msg("cat"), msg("dog"), msg("bird")]).length === 0, "第 3 条超出窗口失效");
		return true;
	}, "window: 增量匹配下滑动窗口过期"],

	[() => {
		const m = new LorebookMatcher([page({ name: "W", triggers: ["cat"], window: 2 })]);
		assert(names(m.match([msg("cat"), msg("dog")])) === "W", "单次调用窗口内激活");
		assert(m.match([msg("cat"), msg("dog"), msg("bird")]).length === 0, "单次调用超出窗口失效");
		return true;
	}, "window: 单次调用内滑动窗口"],

	[() => {
		const m = new LorebookMatcher([page({ name: "P", triggers: ["cat"], window: 0 })]);
		assert(names(m.match([msg("cat"), msg("dog"), msg("bird")])) === "P", "window=0 视为永久激活");
		return true;
	}, "window: window=0 永久激活"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "S", triggers: ["cat"], window: 2 }),
			page({ name: "L", triggers: ["dog"], window: 3 }),
		]);
		assert(names(m.match([msg("cat"), msg("dog")])) === "S,L", "不同 window 页面均激活");
		assert(names(m.match([msg("cat"), msg("dog"), msg("x")])) === "L", "S 过期、L 仍在窗口内");
		return true;
	}, "window: 不同 window 相互独立"],

	// ==========================================================================
	// 增量 / 缓存
	// ==========================================================================
	[() => {
		const m = new LorebookMatcher([page({ name: "A", triggers: ["cat"] })]);
		const r1 = m.match([msg("cat")]);
		const r2 = m.match([msg("cat")]);
		assert(r1 === r2, "相同输入应返回缓存的同一数组引用");
		return true;
	}, "incremental: 相同输入返回缓存引用"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "A", triggers: ["cat"] }),
			page({ name: "B", triggers: ["dog"] }),
		]);
		assert(names(m.match([msg("cat")])) === "A", "首轮仅 A");
		assert(names(m.match([msg("cat"), msg("dog")])) === "A,B", "追加消息后增量更新出 B");
		return true;
	}, "incremental: 追加消息增量更新"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "A", triggers: ["cat"] }),
			page({ name: "B", triggers: ["dog"] }),
		]);
		m.match([msg("cat")]);
		assert(names(m.match([msg("dog")])) === "B", "输入变化后应重置，A 不应残留");
		return true;
	}, "incremental: 输入变化触发重置"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "C", constant: true }),
			page({ name: "A", triggers: ["cat"] }),
		]);
		m.match([msg("cat")]);
		assert(names(m.match([msg("dog")])) === "C", "重置后 constant 页面仍保留");
		return true;
	}, "incremental: 重置后 constant 保留"],

	// ==========================================================================
	// 递归
	// ==========================================================================
	[() => {
		const m = new LorebookMatcher([
			page({ name: "sword", triggers: ["sword"], content: "he holds a shield", recursion: true }),
			page({ name: "shield", triggers: ["shield"], recursion: "only" }),
		]);
		assert(names(m.match([msg("I pick the sword")])) === "sword,shield", "recursion:true 按内容递归激活 only 页面");
		return true;
	}, "recursion: true 按内容触发 only 页面"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "b", recursion: true }),
			page({ name: "b", triggers: ["b"], recursion: "only" }),
		]);
		assert(names(m.match([msg("b")])) === "", "only 页面不直接匹配输入");
		assert(names(m.match([msg("a")])) === "a,b", "经父页面递归激活");
		return true;
	}, "recursion: only 页面仅经父页面激活"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "stone", triggers: ["stone"], content: "a crystal glows", recursion: "stop" }),
			page({ name: "crystal", triggers: ["crystal"], recursion: "only" }),
		]);
		assert(names(m.match([msg("stone")])) === "stone", "stop 页面激活后不向下传播");
		return true;
	}, "recursion: stop 阻断传播"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "b", recursion: true }),
			page({ name: "b", triggers: ["b"], content: "c", recursion: "only" }),
			page({ name: "c", triggers: ["c"], recursion: "only" }),
		]);
		assert(names(m.match([msg("a")])) === "a,b,c", "递归链 a→b→c 应全部激活");
		return true;
	}, "recursion: 递归链传递"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "b", recursion: true }),
			page({ name: "b", triggers: ["b"], content: "a", recursion: true }),
		]);
		assert(names(m.match([msg("a")])) === "a,b", "循环引用应终止而不爆栈");
		return true;
	}, "recursion: 循环引用终止"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "b", recursion: true, window: 2 }),
			page({ name: "b", triggers: ["b"], recursion: "only" }),
		]);
		assert(names(m.match([msg("a")])) === "a,b", "父激活时子一并激活");
		assert(names(m.match([msg("a"), msg("x"), msg("y")])) === "", "父窗口过期时子一并失效");
		return true;
	}, "recursion: 子页面随父窗口过期失效"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "b", recursion: true }),
			page({ name: "b", triggers: ["b"] }),
		]);
		assert(names(m.match([msg("a")])) === "a", "普通（非递归）页面不作为递归目标");
		return true;
	}, "recursion: 普通页面不作为递归目标"],

	[() => {
		const m = new LorebookMatcher([
			page({ name: "a", triggers: ["a"], content: "zzz", recursion: true }),
			page({ name: "b", triggers: ["b"], recursion: "only" }),
		]);
		assert(names(m.match([msg("a")])) === "a", "内容不命中任何触发词则不传播");
		return true;
	}, "recursion: 内容不匹配则不传播"],
];

for (const [fn, name] of lorebookMatcherTests) {
	testRunner.push(fn, name);
}