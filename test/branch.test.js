import {enableBranchesForTest} from "/src/utils/BranchManager.js";
import {testRunner} from "./index.js";
import {BRANCH_MANAGER} from "/src/states.js";

const CHS = obj => Object.getOwnPropertySymbols(obj).find(s=>String(s).includes("CHILDREN"));
const IDX = obj => Object.getOwnPropertySymbols(obj).find(s=>String(s).includes("INDEX"));
const FMS = obj => Object.getOwnPropertySymbols(obj).find(s=>String(s).includes("FoldedMessages"));
const ch = m => m[CHS(m)];
const idx = m => m[IDX(m)];
const fm = m => m[FMS(m)];
const resolveParent = (m) => idx(m) - (m.parent ?? 1);
const isBlock = m => m?.role === 'fold';
let seed = +new Date() % 100000;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ri = n => Math.floor(rnd() * n);

function fail(msg) { console.log("FAIL:", msg); throw new Error(msg); }

function validate(bm, conv, tag) {
	const msgs = bm.raw;
	// 1. INDEX 一致性
	msgs.forEach((m,i)=>{ if(idx(m)!==i) fail(tag+" INDEX mismatch at "+i); });
	// 2. parent 偏移合法且指向更靠前的消息
	for (let i=1;i<msgs.length;i++){
		const p = resolveParent(msgs[i]);
		if (p<0 || p>=msgs.length) fail(tag+" msg#"+i+" parent out of range: "+p);
		if (p>=i) fail(tag+" msg#"+i+" parent >= self: "+p);
	}
	// 3. 从根可达性：所有消息都能沿 parent 走到根
	for (let i=1;i<msgs.length;i++){
		let m = msgs[i], guard=0;
		while (idx(m)!==0){ m = msgs[resolveParent(m)]; if(++guard>msgs.length+5) fail(tag+" cycle/unreachable from #"+i); }
	}
	// 4. CHILDREN 一致性：有 CHILDREN 的节点，children 集合 == 实际子节点集合；无 CHILDREN 的节点最多一个子节点且必须相邻
	const actualChildren = new Map();
	for (let i=1;i<msgs.length;i++){
		const p = msgs[resolveParent(msgs[i])];
		if (!actualChildren.has(p)) actualChildren.set(p, []);
		actualChildren.get(p).push(msgs[i]);
	}
	for (let i=0;i<msgs.length;i++){
		const m = msgs[i];
		const declared = ch(m);
		const actual = actualChildren.get(m) || [];
		if (declared) {
			if (declared.length !== actual.length || !declared.every(d => actual.includes(d)))
				fail(tag+" CHILDREN mismatch for #"+i+": declared=["+declared.map(x=>x.id)+"] actual=["+actual.map(x=>x.id)+"]");
			// 多个子节点时，隐式子节点（无parent）必须是相邻的那个
			for (const c of actual) {
				if (c.parent==null && idx(c)!==i+1)
					fail(tag+" implicit child #"+idx(c)+" not adjacent to parent #"+i);
			}
		} else {
			if (actual.length>1) fail(tag+" node #"+i+" has "+actual.length+" children but no CHILDREN array");
			if (actual.length===1 && idx(actual[0])!==i+1) fail(tag+" node #"+i+" single child not adjacent but no CHILDREN");
		}
	}
	// 5. leaf 存在（允许是被折叠的成员）
	const leafMsg = msgs[conv.bm_leaf];
	if (!leafMsg) fail(tag+" leaf OOB: "+conv.bm_leaf);
	// 6. 折叠不变式：payload 栈锚定在每组的最深成员（块尾）上；payload 总数 == 活跃组数
	let payloadCount = 0;
	const groups = new Map(); // groupId -> members[]
	for (const m of msgs) {
		if (m.folded != null) {
			if (m.foldGroup == null) fail(tag+" payload holder not folded: "+m.id);
			if (!m.folded.length) fail(tag+" empty payload stack: "+m.id);
			payloadCount += m.folded.length;
		}
		if (m.foldGroup) for (const g of m.foldGroup) {
			let arr = groups.get(g);
			if (!arr) groups.set(g, arr = []);
			arr.push(m);
		}
	}
	if (payloadCount !== groups.size) fail(tag+" payload/group mismatch: "+payloadCount+" payloads vs "+groups.size+" groups");
	for (const [g, members] of groups) {
		let anchor = members[0];
		for (const m of members) if (idx(m) > idx(anchor)) anchor = m;
		if (!anchor.folded?.length) fail(tag+" anchor of "+g+" has no payload: "+anchor.id);
	}
	// 7. 路径：不含被折叠成员；块结构合法（成员活跃组 == 块组、start/end 与成员跨度一致、组不重复、成员按从深到浅排列）
	const path = bm;
	const seenGroups = new Set();
	for (const e of path) {
		if (e.role === 'fold') {
			const members = fm(e);
			if (!members || !members.length) fail(tag+" fold block without members");
			if (seenGroups.has(e.group)) fail(tag+" duplicate block group in path");
			seenGroups.add(e.group);
			for (const mm of members)
				if (mm.foldGroup?.at(-1) !== e.group) fail(tag+" member active group != block group: "+mm.id);
			if (e.end !== idx(members.at(-1)) || e.start !== idx(members.at(0))) fail(tag+" block start/end mismatch");
		} else if (e.foldGroup != null) {
			fail(tag+" folded member in path: "+e.id);
		}
	}
	// 8. 路径结尾与 leaf 对应：leaf 可见时结尾是 leaf，被折叠时结尾是包含它的块
	const last = path.at(-1);
	if (last) {
		if (last.role === 'fold') { if (fm(last).at(-1) !== leafMsg) fail(tag+" trailing block does not start with leaf"); }
		else if (last !== leafMsg) fail(tag+" path does not end at leaf");
	} else if (leafMsg !== msgs[0]) fail(tag+" empty path but leaf is not root");
}

function runTrial(trial, steps = 50) {
	const conv = {};
	const raw = [];
	for (let k=0;k<8;k++) raw.push({id:k+1, content:"msg"+(k+1)});
	enableBranchesForTest(conv, raw);

	let nextId = 100;
	let vId = -1;
	let lastBm = conv[BRANCH_MANAGER];

	for (let step=0; step<steps; step++){
		let bm = conv[BRANCH_MANAGER];
		if (!bm) {
			// 停用后复用上一个管理器的 raw（已经不含 SENTRY）重新启用
			const rawMsgs = lastBm.raw;
			enableBranchesForTest(conv, rawMsgs[0] && rawMsgs[0].id === -1 ? rawMsgs.slice(1) : rawMsgs);
			continue;
		}
		lastBm = bm;

		const op = rnd();
		try {
			const p = bm;
			if (op < 0.12) {
				// path.push（可一次多个）
				p.push({id:nextId++, content:"msg"+nextId});
			} else if (op < 0.19) {
				// path.pop
				if (p.length) p.pop();
			} else if (op < 0.30) {
				// branchAt：parent 直接取 path 元素（含折叠块，会分支到块尾）
				if (p.length) bm.branchAt(p[ri(p.length)], {id:nextId++, content:"msg"+nextId});
			} else if (op < 0.39) {
				// splice：删除到结尾
				if (p.length) { const s = ri(p.length); p.splice(s, p.length - s); }
			} else if (op < 0.52) {
				// splice：删除中间一段
				if (p.length > 1) {
					const s = ri(p.length - 1);
					const cnt = 1 + ri(p.length - s - 1);
					p.splice(s, cnt);
				}
			} else if (op < 0.58) {
				// unshift：开头插入虚拟（未入库）消息
				p.unshift({id: vId--, content:"virt"});
			} /*else if (op < 0.66) {
				// remove：删除 path 上的一个元素（消息或折叠块）
				if (p.length) bm.remove(p[ri(p.length)]);
			} */else if (op < 0.78) {
				// fold：折叠 path 上的一段（可嵌套）
				if (p.length) {
					const s = ri(p.length), e = s + ri(p.length - s);
					bm.fold(s, e, {content: 'summary'+(nextId++)});
				}
			} else if (op < 0.86) {
				// unfold：解压 path 上的一个折叠块
				const blocks = p.filter(isBlock);
				if (blocks.length) bm.unfold(blocks[ri(blocks.length)]);
			} else if (op < 0.92) {
				// switchBranch：在分支点上切换
				const cands = p.filter(m => !isBlock(m) && ch(m)?.length > 1);
				if (cands.length) { const m = cands[ri(cands.length)]; bm.switchBranch(m, ri(ch(m).length)); }
			} else if (op < 0.96) {
				// setLeaf：把某条可见消息设为最后一条
				const cands = p.filter(m => !isBlock(m));
				if (cands.length) bm.setLeaf(cands[ri(cands.length)]);
			} else if (op < 0.98) {
				// setLeaf(sync)：从原始数据同步重建
				const cands = p.filter(m => !isBlock(m));
				if (cands.length) bm.setLeaf(cands[ri(cands.length)], true);
			} else {
				// 只读方法
				const cands = p.filter(m => !isBlock(m));
				if (cands.length) {
					const m = cands[ri(cands.length)];
					const info = bm.getBranchInfo(m) ?? [0, 1];
					if (!Array.isArray(info) || info.length !== 2) fail("trial"+trial+" getBranchInfo bad shape");
					if (typeof bm.hasBranch(m) !== 'boolean') fail("trial"+trial+" hasBranch bad shape");
				}
			}
		} catch(e) {
			const msg = String(e && e.message || e);
			if (!(e instanceof DOMException))
				fail("trial"+trial+" step"+step+" op threw: "+msg+(e.stack?"\n"+e.stack.split("\n").slice(0,4).join("\n"):""));
			else {
				console.log("fuzz earyl exit", msg);
				return;
			}
		}

		const cur = conv[BRANCH_MANAGER];
		if (cur) validate(cur, conv, `trial${trial} step${step}(op=${op.toFixed(2)},len=${cur.raw.length})`);
	}
}

testRunner.push(() => {
	for (let t=0;t<300;t++) {
		runTrial(t);
	}
	return true;
}, "BranchManager fuzz test random");
testRunner.push(() => {
	for (let t=0;t<300;t++) {
		seed = t*7919+13;
		runTrial(t);
	}
	return true;
}, "BranchManager fuzz test static");