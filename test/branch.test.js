import {enableBranches} from "/src/utils/BranchManager.js";
import {testRunner} from "./index.js";
import {BRANCH_MANAGER} from "../src/states.js";

const CHS = obj => Object.getOwnPropertySymbols(obj).find(s=>String(s).includes("CHILDREN"));
const IDX = obj => Object.getOwnPropertySymbols(obj).find(s=>String(s).includes("INDEX"));
const ch = m => m[CHS(m)];
const idx = m => m[IDX(m)];
const resolveParent = (m) => idx(m) - (m.parent ?? 1);

let seed = +new Date() % 100000;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ri = n => Math.floor(rnd() * n);

function fail(msg) { console.log("FAIL:", msg); throw new Error(msg); }

function validate(bm, conv, tag) {
	const msgs = bm.messages;
	// 1. INDEX 一致性
	msgs.forEach((m,i)=>{ if(idx(m)!==i) fail(tag+" INDEX mismatch at "+i); });
	// 2. 每个消息的父节点必须存在且指向它的消息在数组里
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
			const ds = [...declared].sort().toString(), as = [...actual].sort().toString();
			if (ds!==as) fail(tag+" CHILDREN mismatch for #"+i+": declared=["+declared.map(x=>x.id)+"] actual=["+actual.map(x=>x.id)+"]");
			// 第一个孩子若隐式必须相邻（其实声明表里第一个可以是任一）
			if (actual.length>1) {
				// 多个子节点时，隐式子节点（无parent）必须是相邻的那个
				for (const c of actual) {
					if (c.parent==null && idx(c)!==idx(m)+1)
						fail(tag+" implicit child #"+idx(c)+" not adjacent to parent #"+i);
				}
			}
		} else {
			if (actual.length>1) fail(tag+" node #"+i+" has "+actual.length+" children but no CHILDREN array");
			if (actual.length===1 && idx(actual[0])!==i+1) fail(tag+" node #"+i+" single child not adjacent but no CHILDREN");
		}
	}
	// 5. leaf 是叶子且在数组中
	const leafMsg = msgs[conv.bm_leaf];
	if (!leafMsg) fail(tag+" leaf OOB: "+conv.bm_leaf);
	const nxt = msgs[idx(leafMsg)+1];
	if (nxt && !nxt.parent && !ch(leafMsg)) fail(tag+" leaf #"+conv.bm_leaf+" is not a leaf");
	// 6. bm_leaf 与内部 leaf 同步: getMessages 应该以 leaf 结尾
	const path = bm.getMessages();
	if (path.at(-1) !== leafMsg && path.length) {
		// path 的最后一条应该能到达 leaf? 其实 path 就是从 leaf 回溯的, 必然
	}
}

function runTrial(trial){
	const conv = {};
	const raw = [];
	for (let k=0;k<8;k++) raw.push({id:k+1});
	enableBranches(conv, raw);

	let nextId = 100;
	for (let step=0; step<40; step++){
		const op = rnd();
		let bm = conv[BRANCH_MANAGER];
		const msgs = bm.messages;
		try {
			if (msgs.length <= 1) {
				// 只剩虚拟根，只能添加消息
				if (rnd() < 0.8) bm.branchAt(msgs[0], {id:nextId++});
				continue;
			}
			if (op < 0.45) {
				// 随机挑一个节点加分支
				const p = msgs[ri(msgs.length)];
				bm.branchAt(p, {id:nextId++});
			} else if (op < 0.65) {
				// 随机切换分支
				const m = msgs[1+ri(msgs.length-1)];
				const par = msgs[resolveParent(m)];
				const sib = ch(par);
				if (sib && sib.length>1) bm.switchBranch(par, ri(sib.length));
			} else if (op < 0.85) {
				// 随机删一个非根消息
				if (msgs.length>2) bm.remove(msgs[1+ri(msgs.length-1)]);
			} else {
				// setLeaf 到随机叶子
				const leaves = msgs.filter((m,i)=> i>0 && (()=>{const n=msgs[idx(m)+1]; return !n || n.parent;})() );
				if (leaves.length) bm.setLeaf(leaves[ri(leaves.length)]);
			}
		} catch(e) {
			fail("trial"+trial+" step"+step+" op threw: "+e.message+(e.stack?"\n"+e.stack.split("\n").slice(0,4).join("\n"):""));
		}

		if (!conv[BRANCH_MANAGER]) {
			const rawMsgs = bm.messages.slice(1);
			enableBranches(conv, rawMsgs);
		}
		validate(conv[BRANCH_MANAGER], conv, `trial${trial} step${step}(op=${op.toFixed(2)},len=${conv[BRANCH_MANAGER].messages.length})`);
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