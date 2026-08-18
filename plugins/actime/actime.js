import "./actime.css";
import {messages, selectedConversation} from "/src/states.js";
import {unconscious} from "unconscious";
import {getBillingLog} from "/src/database.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {showToast} from "/src/components/Toast.js";


function buildData(messages, logs) {
	const firstTime = messages[0]?.time || 0;

	let thinkTimeSum = 0, toolTimeSum = 0, subagentTimeSum = 0, waitingTimeSum = 0;
	let assistantTurns = 0;
	let prevEnd = 0;

	const agg = new Map();
	for (let idx = 0; idx < messages.length; idx++) {
		const m = messages[idx];

		const thisStart = m.time;
		if (prevEnd) {
			const delta = thisStart - prevEnd;
			// 只统计合理间隔：忽略时间乱序导致的负值和超过1小时的离开
			if (delta > 0 && delta <= 3600000) waitingTimeSum += delta;
			prevEnd = 0; // 不计算多条user消息之间吗？
		}

		if (m.role !== 'assistant') continue;
		assistantTurns++;

		let thisEnd;

		const dur = m.think?.duration;
		if (dur > 0) thinkTimeSum += dur;

		const resps = m.tool_responses;
		const calls = m.tool_calls;
		if (resps && calls) {
			for (let i = 0; i < calls.length; i++) {
				const resp = resps[i];
				if (!resp) continue;
				// duration 是可选字段，且可能为负/NaN，统一清洗
				const duration = resp.duration > 0 ? resp.duration : 0;
				if (resp.time > 0) thisEnd = resp.time + duration;

				const toolName = calls[i].function.name;
				const a = agg.get(toolName) || { calls: 0, sumMs: 0 };
				a.calls++; a.sumMs += duration;
				agg.set(toolName, a);

				if (toolName === 'CreateAgent') {
					try {
						const args = JSON.parse(calls[i].function.arguments || '{}');
						if (args.async !== true) {
							subagentTimeSum += duration;
							continue;
						}
					} catch {}
				}
				toolTimeSum += duration;
			}
		}

		if (!thisEnd) {
			const bill = logs[idx];
			if (bill && bill.time > 0) thisEnd = bill.time + (bill.duration > 0 ? bill.duration : 0);
		}

		// 没有任何耗时信息时，至少保证时间轴不回退，避免 prevEnd 为 undefined/NaN
		if (!thisEnd || thisEnd < m.time) thisEnd = m.time;

		prevEnd = thisEnd;
	}

	const totalTime = Math.max(0, prevEnd - firstTime) / 1000;
	const runningTime = Math.max(0, totalTime - waitingTimeSum / 1000);

	// tokens / cost / cache
	const bills = logs.filter(Boolean);
	let inTokens = 0, outTokens = 0, cachedTokens = 0, cost = 0, latMs = 0, latN = 0;
	const cachePoints = [];
	for (const b of bills) {
		if (b.input_tokens != null) {
			inTokens += b.input_tokens;
			outTokens += b.output_tokens;
			cachedTokens += b.cached_tokens || 0;
			// 不要原地修改 log 对象，否则重复渲染会重复打折
			if (b.cost) cost += b.currency === 'CNY' ? b.cost * 0.15 : b.cost;
			const denom = b.input_tokens + (b.cached_tokens || 0);
			cachePoints.push(denom > 0 ? ((b.cached_tokens || 0) / denom) * 100 : 0);
		} else {
			cachePoints.push(0);
		}
		if (b.latency > 0) { latMs += b.latency; latN++; }
	}

	const cacheAvg = cachedTokens ? (cachedTokens / (inTokens + cachedTokens)) * 100 : 0;

	const tools = [...agg.entries()]
		.map(([tname, { calls, sumMs }]) => ({ name: tname, calls, sumMs }))
		.sort((a, b) => b.calls - a.calls);

	return {
		runningTime, totalTime,
		breakdown: [
			{ key: 'thinking', label: '推理', sec: thinkTimeSum / 1000 },
			{ key: 'tool',     label: '工具调用', sec: toolTimeSum / 1000 },
			{ key: 'subagent', label: '子代理', sec: subagentTimeSum / 1000 },
			{ key: 'waiting',  label: '等待',  sec: waitingTimeSum / 1000 },
		],
		inTokens, outTokens,
		cache: { avg: cacheAvg, points: cachePoints },
		cost: cost / 1000000,
		costPerMin: runningTime > 0 ? cost / 1000000 / (runningTime / 60) : 0,
		avgResponseTime: latN ? latMs / latN : 0,
		turns: assistantTurns,
		tools,
	};
}

/* ========================================================================
   2) cache 图降采样：每个柱子至少 4px，放不下按桶平均
   ======================================================================== */
function downsample(points, maxBars) {
	if (points.length <= maxBars) return points;
	const bucket = Math.ceil(points.length / maxBars);
	const out = [];
	for (let i = 0; i < points.length; i += bucket) {
		const slice = points.slice(i, i + bucket);
		out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
	}
	return out;
}

/* ========================================================================
   3) 渲染（只算数值，样式在 run-card.css）
   ======================================================================== */
const fmtDur = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`);

let maxBars = 80;

async function render() {
	const conv = unconscious(selectedConversation);
	const msgs = unconscious(messages);
	const logs = await Promise.all(msgs.map(m => getBillingLog(m.id)));
	const d =  buildData(msgs, logs);

	d.breakdown = d.breakdown.filter(b => b.sec).sort((a, b) => b.sec - a.sec);
	const total = d.breakdown.reduce((a, b) => a + b.sec, 0);
	// 所有工具耗时都为 0 时避免 0/0 = NaN 宽度
	const maxTime = Math.max(1, ...d.tools.map(t => t.sumMs));
	const cachePoints = downsample(d.cache.points, maxBars);

	const bars = d.breakdown.map((b) => <span style={`width:${(b.sec / total * 100)}%;background:var(--c-${b.key})`}></span>);

	const rows = d.breakdown.map((b) => <div className={`tb-row${b.key === 'waiting' ? ' tb-row--wait' : ''}`}>
		<span className="name"><span className="dot" style={`background:var(--c-${b.key})`}></span>{b.label}</span>
		<span className="dur">{fmtDur(b.sec)}</span>
		<span className="pct">{Math.round((b.sec / total) * 100)}%</span>
	</div>);

	return <article className="run-card">
		<header className="header">
			<h1 className="title">{conv.title || '无标题会话'}</h1>
			<p className="meta">{new Date(conv.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
		</header>

		<section className="section">
			<h2 className="section-title">耗时
				<span className={"spacer"}></span>
				<span title={"墙钟时间"}>共计 {fmtDur(d.totalTime)}</span>
			</h2>
			<div className="stacked-bar" role="img">{bars}</div>
			<div className="time-breakdown">{rows}</div>
		</section>

		<section className="section">
			<h2 className="section-title">消耗<span className={"spacer"}></span><span>{d.turns} 次请求</span></h2>
			<div className="stat-grid">
				<div className="stat">
					<div className="label">输入</div>
					<b className="value">{fmtK(d.inTokens)}</b></div>
				<div className="stat">
					<div className="label">输出</div>
					<b className="value">{fmtK(d.outTokens)}</b></div>
				<div className="stat">
					<div className="label">花费</div>
					<b className="value">${d.cost.toFixed(2)}<small> · ${d.costPerMin.toFixed(2)}/min</small></b></div>
			</div>
			{d.cache.points.length && <>
				<div className="cache-head">
					<span className="cache-label">缓存命中 {d.cache.avg.toFixed(2)}%</span>
					<span className="cache-label">平均延迟 {fmtMs(d.avgResponseTime)}</span>
				</div>
				<div className="cache-chart" id="cache-chart">
					<div className="cache-avg-line" style={`--avg:${d.cache.avg}%`}></div>
					<div className="cache-bars">
						{cachePoints.map((p, i) =>
							<div className={`cache-bar${p < d.cache.avg ? ' cache-bar--low' : ''}`}
								 style={`height:${p}%`}
								 title={`请求 ${i + 1} · ${p.toFixed(2)}% hit`}></div>)}
					</div>
				</div>
				<div className="cache-x"><span>1</span><span>请求 →</span><span>{d.cache.points.length}</span></div>
			</>}
		</section>

		{d.tools.length && <section className="section">
			<h2 className="section-title">工具</h2>
			{d.tools.map((t) =>
				<div className="tool-row">
					<span className="tool-name">{t.name}</span>
					<div className="tool-track">
						<div className={`tool-fill${t.sumMs >= 1000 ? ' tool-fill--exec' : ''}`}
							 style={`width:${(t.sumMs / maxTime * 100)}%`}></div>
					</div>
					<span className="tool-meta"><span className="calls">{t.calls}</span><span
						className="avg">{fmtMs(t.sumMs)}</span></span>
				</div>)}
		</section>}
	</article>;
}

COMMAND_REGISTRY['actime'] = [
	() => {
		render().then(elem => {
			elem.addEventListener('contextmenu', () => elem.remove());
			showToast("长按以关闭")
			document.body.append(<div style={"position: absolute;right:0"}>{elem}</div>);
		});
	},
	"显示耗时详情卡片便于炫耀"
]
