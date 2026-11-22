import {unconscious} from "unconscious";
import Chart from "/common/Chart.js";
import {formatDate} from "unconscious/common/Utils.js";
import {isIDB, listBillingLogs} from "/src/database.js";
import {requestBackend} from "/src/database/remoteDB.js";
import {LLM_COST_SCALE} from "/backend/sync.js";
import {highlightJsonLike} from "/src/markdown/highlight.js";
import {openWindow} from "/src/components/Windows.jsx";
import {prettyError} from "/src/utils/utils.js";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {EVENT_BUS} from "/src/states.js";

import "./log_viewer.css";

// ============ STATE ============
let allLogs = [];
let filteredLogs = [];
let currentPage = 1;
const pageSize = 20;
let currentSort = { field: 'time', direction: 'desc' };
let tokenChartInstance = null;
let costChartInstance = null;

// ============ CACHE ============
const MAX_CACHE_SIZE = 100000;
let cachedLogs = []; // sorted by time descending

// Binary search: logs sorted by time descending → find first index with log.time <= target
function bsearchLE(logs, target) {
    let lo = 0, hi = logs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (logs[mid].time <= target) hi = mid - 1;
        else lo = mid + 1;
    }
    return lo;
}

// Binary search: logs sorted by time descending → find first index with log.time < target
function bsearchLT(logs, target) {
    let lo = 0, hi = logs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (logs[mid].time < target) hi = mid - 1;
        else lo = mid + 1;
    }
    return lo;
}

function normalizeCachedLog(log) {
	if (log.cost) {
		log.cost /= LLM_COST_SCALE;
		// Currency conversion
		if (log.currency === "USD") {
			log.cost /= 0.15;
		}
		log.currency = "CNY";
	}
	return log;
}

// ============ DOM REFS ============
/**
 * @type {HTMLElement}
 */
let $presetBtns,
	$tableBody, $tableScroll, $paginationInfo,
	$refreshIndicator,
	$startDate, $endDate, $filterProvider,
	$filterModel, $filterFinishReason, $autoRefreshBtn,
	chartCostSubtitle, chartTokenSubtitle, costChart, statAvgDuration,
	statAvgTTFT, statCachedTokens, statCachedTokensSub, statInputTokens,
	statInputTokensSub, statOutputTokens, statReasoningTokens, statTotalCost,
	statTotalCostSub, statTotalRequests, tokenChart;

// ============ UTILS ============
const formatNumber = n => {
	if (n == null || isNaN(n)) return '—';
	if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'G';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
	return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatCostTbl = (c, currency) => {
	if (c == null || isNaN(c)) return '—';
	const sym = currency === 'CNY' ? '¥' : '$';
	return sym + c.toFixed(6);
};

const formatDuration = ms => {
	if (ms == null || isNaN(ms)) return '—';
	if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
	return Math.round(ms) + 'ms';
};

const formatTime = ts => {
	const d = new Date(ts);
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	if (isToday) return formatDate('今天 H:i:s', ts);
	return formatDate('Y-m-d H:i:s', ts);
};

function getFinishBadge(reason) {
	const r = reason.toLowerCase();
	if (r === 'stop' || r === 'end_turn') return <span className="badge -s">stop</span>;
	if (r === 'length' || r === 'max_tokens') return <span className="badge -w">length</span>;
	if (r.includes('tool')) return <span className="badge -i">{reason}</span>;
	if (r === 'error' || r === 'content_filter') return <span className="badge -e">{reason}</span>;
	return <span className="badge">{reason}</span>;
}

// ============ TIME RANGE ============
const getTimeRange = () => [+new Date($startDate.value), +new Date($endDate.value)];

const clearActivePresetBtn = () => {
	$presetBtns.querySelector('.btn-active')?.classList.remove('btn-active');
};

const setPresetRange = (range, __skipUpdate) => {
	clearActivePresetBtn();
	$presetBtns.querySelector(`[data-range="${range}"]`)?.classList.add('btn-active');

	const n = parseInt(range, 10);
	const type = range[range.length - 1].toLowerCase();
	const end = new Date();
	const start = new Date(end);

	switch (type) {
		case 'h':
			// 最近 n 小时：从当前时间往前推 n 小时
			start.setTime(end.getTime() - n * 60 * 60 * 1000);
			break;

		case 'd': {
			// 自然日，包含今天：
			// n 天 = 从 n-1 天前的 00:00:00 到今天 23:59:59.999
			start.setDate(start.getDate() - (n - 1));
			start.setHours(0, 0, 0, 0);
			end.setHours(23, 59, 59, 999);
			break;
		}

		case 'm': {
			// 自然月，包含当月：
			// n 个月 = 从 n-1 个月前的 1 号 00:00:00 到当月最后一天 23:59:59.999
			start.setMonth(start.getMonth() - (n - 1), 1);
			start.setHours(0, 0, 0, 0);
			end.setMonth(end.getMonth() + 1, 0);
			end.setHours(23, 59, 59, 999);
			break;
		}
	}

	$startDate.value = formatDate("Y-m-dTH:i", start);
	$endDate.value = formatDate("Y-m-dTH:i", end);

	if (!__skipUpdate) refreshData();
};

// ============ API CALL ============
const fetchPrices = () => requestBackend("database/fetch", {"method": "POST"}).then(() => cachedLogs.length = 0);

const BATCH_LIMIT = 5000;
// 这些函数假设毫秒时间戳是unique的了……也许哪天我真拿time做主键呢/doge

const realFetchLogs = async (start, end, callback) => {
	let cursor;

	while (true) {
		const logs = await listBillingLogs(start, end, cursor);

		logs.forEach(normalizeCachedLog)
		callback(logs);

		if (isIDB || logs.length < BATCH_LIMIT) break;

		const last = logs.at(-1);
		cursor = last.id;
		end = last.time - 1;
		if (end <= start) break;
	}
};

async function fetchLogs() {
	const [ start, end ] = getTimeRange();

	if (cachedLogs.length === 0) {
		await realFetchLogs(start, end, logs => cachedLogs.push(...logs));
	} else {
		const newestCachedTime = cachedLogs[0].time;
		const oldestCachedTime = cachedLogs.at(-1).time;

		const promises = [];

		if (end > newestCachedTime) {
			promises.push(realFetchLogs(Math.max(start, newestCachedTime+1), end, logs => cachedLogs.unshift(...logs)));
		}
		if (start < oldestCachedTime) {
			promises.push(realFetchLogs(start, Math.min(end, oldestCachedTime-1), logs => cachedLogs.push(...logs)));
		}

		await Promise.all(promises);
	}

	if (cachedLogs.length > MAX_CACHE_SIZE)
		cachedLogs = cachedLogs.slice(-MAX_CACHE_SIZE);

	const left = bsearchLE(cachedLogs, end);
	const right = bsearchLT(cachedLogs, start);
	return cachedLogs.slice(left, right);
}

// ============ DATA PROCESSING ============
function processLogs(logs) {
	logs.forEach(log => {
		const total_tokens = (log.input_tokens || 0) + (log.output_tokens || 0) + (log.cached_tokens || 0);
		if (total_tokens) log.total_tokens = total_tokens;
	});
	return logs;
}

function updateFilters() {
	const providers = new Set();
	const models = new Set();
	const finishReasons = new Set();
	allLogs.forEach(log => {
		if (log.provider) providers.add(log.provider);
		if (log.model) models.add(log.model);
		if (log.finish_reason) finishReasons.add(log.finish_reason);
	});

	const currentProv = $filterProvider.value;
	const currentModel = $filterModel.value;
	const currentFR = $filterFinishReason.value;

	const mapToOption = p => <option value={p}>{p}</option>;
	$filterProvider.replaceChildren(<option value="">渠道</option>, ...[...providers].sort().map(mapToOption));
	$filterModel.replaceChildren(<option value="">模型</option>, ...[...models].sort().map(mapToOption));
	$filterFinishReason.replaceChildren(<option value="">状态</option>, ...[...finishReasons].sort().map(mapToOption));

	$filterProvider.value = providers.has(currentProv) ? currentProv : '';
	$filterModel.value = models.has(currentModel) ? currentModel : '';
	$filterFinishReason.value = finishReasons.has(currentFR) ? currentFR : '';
}

const applyFilters = () => {
	const provFilter = $filterProvider.value;
	const modelFilter = $filterModel.value;
	const frFilter = $filterFinishReason.value;

	filteredLogs = allLogs.filter(log => {
		if (provFilter && log.provider !== provFilter) return false;
		if (modelFilter && log.model !== modelFilter) return false;
		if (frFilter && log.finish_reason !== frFilter) return false;
		return true;
	});

	updateStats();
	updateCharts();

	currentPage = Math.min(currentPage, Math.max(1, Math.ceil(filteredLogs.length / pageSize)));
	if (filteredLogs.length === 0) currentPage = 1;

	applySort();
};
const applySort = () => {
	// Sort
	const sf = currentSort.field;
	const sd = currentSort.direction;
	filteredLogs.sort((a, b) => {
		let va = a[sf];
		let vb = b[sf];
		if (sf === 'total_tokens') {
			va = (a.input_tokens || 0) + (a.output_tokens || 0) + (a.cached_tokens || 0)
			vb = (b.input_tokens || 0) + (b.output_tokens || 0) + (b.cached_tokens || 0);
		}
		if (va == null) va = 0;
		if (vb == null) vb = 0;
		if (typeof va === 'string') va = va.toLowerCase();
		if (typeof vb === 'string') vb = vb.toLowerCase();
		if (va < vb) return sd === 'asc' ? -1 : 1;
		if (va > vb) return sd === 'asc' ? 1 : -1;
		return 0;
	});

	renderTable();
};

// ============ STATS ============
function updateStats() {
	const logs = filteredLogs;
	const total = logs.length;
	const inputTokens = logs.reduce((s, l) => s + (l.input_tokens || 0), 0);
	const outputTokens = logs.reduce((s, l) => s + (l.output_tokens || 0), 0);
	const reasoningTokens = logs.reduce((s, l) => s + (l.reasoning_tokens || 0), 0);
	const cachedTokens = logs.reduce((s, l) => s + (l.cached_tokens || 0), 0);
	const cacheWriteTokens = logs.reduce((s, l) => s + (l.cache_write_tokens || 0), 0);
	const totalCost = logs.reduce((s, l) => s + (l.cost || 0), 0);
	const avgDuration = total > 0 ? logs.reduce((s, l) => s + (l.duration || 0), 0) / total : 0;
	const avgTTFT = total > 0 ? logs.reduce((s, l) => s + (l.latency || 0), 0) / total : 0;
	const cacheHitRate = (inputTokens + cachedTokens) > 0 ? cachedTokens / (inputTokens + cachedTokens) * 100 : 0;

	statTotalRequests.textContent = formatNumber(total);
	statInputTokens.textContent = formatNumber(inputTokens);
	statInputTokensSub.textContent = outputTokens > 0 ? `每次 ${formatNumber(Math.round(inputTokens / total))}↑ ${formatNumber(Math.round(outputTokens / total))}↓` : '';
	statOutputTokens.textContent = formatNumber(outputTokens);
	statReasoningTokens.textContent = `${formatNumber(reasoningTokens)}`;
	statTotalCost.textContent = '¥'+totalCost.toFixed(2);
	statTotalCostSub.textContent = total > 0 ? `每次 ${formatCostTbl(totalCost / total, 'CNY')}` : '';
	statAvgDuration.textContent = formatDuration(avgDuration);
	statAvgTTFT.textContent = formatDuration(avgTTFT);
	statCachedTokens.textContent = formatNumber(cachedTokens);
	statCachedTokensSub.textContent = `缓存读: ${cacheHitRate.toFixed(1)}% | 写: ${formatNumber(cacheWriteTokens)}`;
}

// ============ CHARTS ============
function getBucketSize() {
	const [ start, end ] = getTimeRange();
	const rangeSec = end - start;
	if (rangeSec <= 2 * 3600 * 1000) return 'minute'; // <=2 hours: minute
	if (rangeSec <= 2 * 86400 * 1000) return 'hour'; // <=2 days: hourly
	if (rangeSec <= 60 * 86400 * 1000) return 'day'; // <=60 days: daily
	return 'week';
}

function getBucketLabel(ts, bucketSize) {
	if (bucketSize === 'minute') {return formatDate("H:i", parseInt(ts / (5 * 60 * 1000)) * (5 * 60 * 1000));}
	if (bucketSize === 'hour') {return formatDate("m-d H:00", ts);}
	if (bucketSize === 'day') {return formatDate("m-d", ts);}
	const d = new Date(ts);
	// week
	const startOfWeek = new Date(d);
	const day = d.getDay(); // 0 是周日
	const diff = (day + 6) % 7; // 距离本周一的天数
	startOfWeek.setDate(d.getDate() - diff);
	return `${String(startOfWeek.getMonth()+1).padStart(2,'0')}-${String(startOfWeek.getDate()).padStart(2,'0')} 周`;
}

function aggregateLogs(logs) {
	const bucketSize = getBucketSize();
	const [ start, end ] = getTimeRange();
	const buckets = new Map();

	// Determine bucket duration in seconds
	let bucketDur;
	if (bucketSize === 'hour') bucketDur = 3600 * 1000;
	else if (bucketSize === 'minute') bucketDur = 5 * 60 * 1000;
	else if (bucketSize === 'day') bucketDur = 86400 * 1000;
	else bucketDur = 7 * 86400 * 1000;

	// Create empty buckets
	for (let t = start; ; t += bucketDur) {
		const label = getBucketLabel(t, bucketSize);
		buckets.set(label, {
			label,
			timestamp: t,
			input_tokens: 0,
			output_tokens: 0,
			reasoning_tokens: 0,
			cached_tokens: 0,
			cache_write_tokens: 0,
			cost: 0,
			requests: 0,
		});

		if (t >= end) break;
	}

	// Fill buckets
	logs.forEach(log => {
		const logTime = log.time || 0;
		const label = getBucketLabel(logTime, bucketSize);
		let b = buckets.get(label);
		if (!b) {
			console.log("error could not found", label);
			return;
		}
		b.input_tokens += (log.input_tokens || 0);
		b.output_tokens += (log.output_tokens || 0);
		b.reasoning_tokens += (log.reasoning_tokens || 0);
		b.cached_tokens += (log.cached_tokens || 0);
		b.cache_write_tokens += (log.cache_write_tokens || 0);
		b.cost += (log.cost || 0);
		b.requests += 1;
	});

	const bucketArr = [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
	return { bucketArr, bucketSize };
}

function updateCharts() {
	const { bucketArr, bucketSize } = aggregateLogs(filteredLogs);
	const LOG_ZERO = 0.1;
	const labels = bucketArr.map(b => b.label);
	const inputData = bucketArr.map(b => Math.max(b.input_tokens, LOG_ZERO));
	const outputData = bucketArr.map(b => Math.max(b.output_tokens, LOG_ZERO));
	const reasoningData = bucketArr.map(b => Math.max(b.reasoning_tokens, LOG_ZERO));
	const cachedData = bucketArr.map(b => Math.max(b.cached_tokens, LOG_ZERO));
	const costData = bucketArr.map(b => b.cost);
	const requestData = bucketArr.map(b => b.requests);

	const bucketLabelZh = bucketSize === 'hour' ? '小时' : bucketSize === 'day' ? '天' : bucketSize === 'minute' ? '分钟' : '周';
	chartTokenSubtitle.textContent = chartCostSubtitle.textContent = `按${bucketLabelZh}聚合`;

	// Token chart
	if (tokenChartInstance) tokenChartInstance.destroy();
	const tokenCtx = tokenChart.getContext('2d');
	const datasets = [];
	const colors = [
		{ label: '输入', color: '#4d94ff', data: inputData },
		{ label: '输出', color: '#3db87b', data: outputData },
		{ label: '缓存 (对数)', color: '#3cc8c8', data: cachedData },
	];
	if (reasoningData.some(v => v > 0)) {
		colors.splice(2, 0, { label: '思考', color: '#9b7ef0', data: reasoningData });
	}
	colors.forEach((c, i) => {
		datasets.push({
			label: c.label,
			data: c.data,
			borderColor: c.color,
			backgroundColor: i > 1 && c.color + (i === colors.length - 1 ? '40' : ''),
			fill: i > 1,
			borderWidth: i > 1 ? 0 : 2,
			tension: 0.25,
			pointRadius: i > 1 ? 0 : 3,
			pointHoverRadius: 5,
			pointBackgroundColor: c.color,
		});
	});
	datasets.at(-1).yAxisID = 'y1';

	tokenChartInstance = new Chart(tokenCtx, {
		type: 'line',
		data: { labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: 'index', intersect: false },
			plugins: {
				legend: {
					position: 'top',
					labels: {
						color: '#9ba3b5',
						usePointStyle: true,
						font: { size: 11 },
					},
				},
				tooltip: {
					backgroundColor: '#1a1f2b',
					titleColor: '#e8ecf1',
					bodyColor: '#c0c7d3',
					borderColor: '#323a4a',
					borderWidth: 1,
					padding: 12,
					cornerRadius: 8,
					callbacks: {
						label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.raw)}`,
					},
				},
			},
			scales: {
				x: {
					ticks: {
						color: '#94A3B8',
						maxRotation: 45,
						font: { size: 10 },
					},
					grid: { color: '#323a4a' },
				},
				y: {
					ticks: {
						color: '#94A3B8',
						font: { size: 10 },
						callback: formatNumber,
					},
					grid: { color: '#323a4a' },
				},
				y1: {
					position: 'right',
					type: "logarithmic",
					min: LOG_ZERO,
					ticks: {
						color: '#3cc8c8',
						font: { size: 10 },
						callback: formatNumber,
					},
					grid: { drawOnChartArea: false },
				},
			},
		},
	});

	// Cost chart
	if (costChartInstance) costChartInstance.destroy();
	const costCtx = costChart.getContext('2d');
	const currency = 'CNY';
	const max = Math.max(...costData);
	costChartInstance = new Chart(costCtx, {
		type: 'bar',
		data: {
			labels,
			datasets: [
				{
					label: '成本',
					data: costData,
					backgroundColor: costData.map(v => `rgba(240,160,80,${0.2 + 0.6 * (max ? v / max : 0)})`),
					borderColor: '#f0a050',
					borderWidth: 1,
					borderRadius: 4,
					yAxisID: 'y',
					order: 2,
				},
				{
					label: '调用',
					data: requestData,
					type: 'line',
					borderColor: '#4d94ff',
					borderWidth: 2,
					tension: 0.35,
					pointRadius: 3,
					pointHoverRadius: 5,
					pointBackgroundColor: '#4d94ff',
					yAxisID: 'y1',
					order: 1,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: 'index', intersect: false },
			plugins: {
				legend: {
					position: 'top',
					labels: {
						color: '#94A3B8',
						usePointStyle: true,
						font: { size: 11 },
					},
				},
				tooltip: {
					backgroundColor: '#1a1f2b',
					titleColor: '#e8ecf1',
					bodyColor: '#c0c7d3',
					borderColor: '#323a4a',
					borderWidth: 1,
					padding: 12,
					cornerRadius: 8,
					callbacks: {
						label: (ctx) => {
							if (ctx.dataset.label.includes('成本')) return `${ctx.dataset.label}: ${formatCostTbl(ctx.raw, currency)}`;
							return `${ctx.dataset.label}: ${formatNumber(ctx.raw)}`;
						},
					},
				},
			},
			scales: {
				x: {
					ticks: { color: '#94A3B8', maxRotation: 45, font: { size: 10 }, },
					grid: { color: '#323a4a' },
				},
				y: {
					ticks: {
						color: '#f0a050',
						font: { size: 10 },
						callback: (v) => "¥"+v.toFixed(2),
					},
					grid: { color: '#323a4a' },
					beginAtZero: true,
				},
				y1: {
					position: 'right',
					ticks: {
						color: '#4d94ff',
						font: { size: 10 },
						callback: formatNumber,
					},
					grid: { drawOnChartArea: false },
					beginAtZero: true,
				},
			},
		},
	});
}

const vl = new VirtualList({
	overscan: 1000,
	renderer(log, i) {
		const currency = log.currency || 'USD';
		const totalTok = (log.input_tokens || 0) + (log.output_tokens || 0) + (log.cached_tokens || 0);
		const cachedInfo = log.cached_tokens ? <span style="color:#3cc8c8" title="缓存命中">{formatNumber(log.cached_tokens)}</span> : '—';

		const makeDetails = () => <div className="expand-row-detail" onClick.stop={() => {}}>
			<pre dangerouslySetInnerHTML={highlightJsonLike(log)} />
		</div>;

		const self = <div className={"vt-row" + (i & 1 ? ' -d' : '')} onClick={() => toggleRow(log, self, makeDetails)}>
			<div className="text-secondary mono" style="font-size:12px">{formatTime(log.time)}</div>
			<div><span style="font-weight:500;color:#c8d0dc">{log.provider || '—'}</span></div>
			<div className="mono ellipsis" title={log.model}>{log.model}</div>
			<div className="mono" style="text-align:right;color:#8ab4f8">{formatNumber(log.input_tokens)}</div>
			<div className="mono" style="text-align:right;color:#6ddb9e">{formatNumber(log.output_tokens)}</div>
			<div className="mono" style="text-align:right;font-weight:600;color:#e8ecf1">{formatNumber(totalTok)}</div>
			<div className="mono" style="text-align:right">{cachedInfo}</div>
			<div className="mono" style="text-align:right;font-weight:600;color:#f0c060">{formatCostTbl(log.cost, currency)}</div>
			<div className="mono" style="text-align:right;color:#e0a870">{log.duration == null ? "非流" : formatDuration(log.duration)}</div>
			<div className="mono" style="text-align:right;color:#e890b0">{formatDuration(log.latency)}</div>
			<div style="text-align:center">{getFinishBadge(log.finish_reason)}</div>
		</div>;
		return self;
	},
});

// ============ TABLE ============
function renderTable() {
	if (filteredLogs.length === 0) {
		$tableBody.replaceChildren(
			<div className="state-message">
				<div className="state-icon">📭</div>
				<div className="state-title">暂无数据</div>
				<div className="state-desc">所选时间范围内没有匹配的调用日志</div>
			</div>
		);
		vl.destroy();
	} else {
		$tableBody.replaceChildren();
		vl.dom = $tableBody;
		vl.attach($tableBody.closest('.main-container'));
		vl.setItems(unconscious(filteredLogs));
	}

	// Update sort header
	$tableScroll.querySelectorAll(' .vt-head > .sortable').forEach(th => {
		const field = th.dataset.sort;
		th.classList.toggle('sorted', field === currentSort.field);
		const arrow = th.querySelector('.sort-arrow');
		if (arrow && field === currentSort.field) {
			arrow.textContent = currentSort.direction === 'asc' ? '▴' : '▾';
		} else if (arrow) {
			arrow.textContent = '▾';
		}
	});
}

// ============ GLOBAL FUNCTIONS ============
const toggleRow = async (log, row, makeDetails) => {
	const has = row.classList.toggle("expanded");
	if (has) {
		if (!log.request_id) {
			const fullLog = (await requestBackend(`batch`, {
				method: 'POST',
				body: [["log/by-rowid", log.id]]
			}))[0];
			if (fullLog) {
				normalizeCachedLog(fullLog);
				Object.assign(log, fullLog);
			}
		}
		const newEl = makeDetails();
		row.insertAdjacentElement("beforeend", newEl);
		newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
	} else {
		row.lastElementChild.remove();
	}
};


const refreshData = async (auto) => {
	$refreshIndicator.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid #6b7385;border-top-color:#4d94ff;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:4px;"></span> 加载中...';
	try {
		const logs = await fetchLogs();
		if (auto === true && logs.length && logs.at(-1) === allLogs.at(-1)) {

		} else {
			allLogs = processLogs(logs);
			updateFilters();
			applyFilters();
		}
		const now = new Date();
		$refreshIndicator.innerHTML = allLogs.length+` 条记录, 更新于 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
	} catch (err) {
		console.error('获取日志失败:', err);
		$refreshIndicator.innerHTML = '<span style="color:#e0556a">⚠ 加载失败</span>';
		if (allLogs.length === 0) {
			$tableBody.replaceChildren(
				<div className="state-message">
					<div className="state-icon">⚠️</div>
					<div className="state-title">加载失败</div>
					<div className="state-desc">{prettyError(err)}</div>
					<button className="ri-loop-right-line ghost" onClick={refreshData}>重试</button>
				</div>
			);
		}
	}
};

// ============ EVENT LISTENERS ============

const createLogViewer = () => {
	const state = {
		onFocus(focused) {
			if (focused) refreshData(true);
		},
		element: <>
			<div className="top-bar row">
				<b className="-label">时间范围</b>
				<div className="btn-group" ref={$presetBtns} onClick.delegate{"button"}={({delegateTarget: btn}) => {
					const range = btn.dataset.range;
					if (range) setPresetRange(range);
				}}>
					<button className="btn" data-range="1h">1小时</button>
					<button className="btn" data-range="24h">24小时</button>
					<button className="btn" data-range="1d">今天</button>
					<button className="btn" data-range="7d">7天</button>
					<button className="btn" data-range="1m">本月</button>
				</div>
				<div>
					<input type="datetime-local" className="-date" ref={$startDate} title="开始时间"
						   onChange={() => {
							   clearActivePresetBtn();
							   refreshData();
						   }}
					/>
					<span className="-sep">—</span>
					<input type="datetime-local" className="-date" ref={$endDate} title="结束时间"
						   onChange={() => {
							   clearActivePresetBtn();
							   refreshData();
						   }}
					/>
				</div>
				<span className="spacer"/>
				<span className="refresh-indicator" ref={$refreshIndicator}></span>
				<button className="btn" onClick={({target}) => {
					target.disabled = true;
					(isIDB ? refreshData() : fetchPrices().then(refreshData)).finally(() => {
						target.disabled = false;
					})
				}}><i className="ri-loop-right-line" /> 刷新</button>
			</div>

			<div className="main-container">
				<div className="stats-grid">
					<div className="stat-card">
						<div className="-label"><div className="-icon -blue ri-bar-chart-box-line" />调用次数</div>
						<div className="-value" ref={statTotalRequests}>—</div>
						<div className="-sub" ref={statInputTokensSub}></div>
					</div>
					<div className="stat-card">
						<div className="-label"><div className="-icon -green ri-arrow-up-line" />输入 Tokens</div>
						<span className="-value" title={"未缓存输入"} ref={statInputTokens}>—</span>/<span
						title={"缓存输入"} ref={statCachedTokens}>—</span>
						<div className="-sub" ref={statCachedTokensSub}></div>
					</div>
					<div className="stat-card">
						<div className="-label"><div className="-icon -purple ri-arrow-down-line" />输出 Tokens</div>
						<span className="-value" title={"总输出"} ref={statOutputTokens}>—</span>/<span
						title={"思考"} ref={statReasoningTokens}>—</span>
					</div>
					<div className="stat-card">
						<div className="-label"><div className="-icon -cyan ri-money-dollar-circle-line" />成本</div>
						<div className="-value" ref={statTotalCost}>—</div>
						<div className="-sub" ref={statTotalCostSub}></div>
					</div>
					<div className="stat-card">
						<div className="-label"><div className="-icon -pink ri-flashlight-fill" />首字延迟</div>
						<div className="-value" ref={statAvgTTFT}>—</div>
					</div>
					<div className="stat-card">
						<div className="-label"><div className="-icon -orange ri-timer-line" />耗时</div>
						<div className="-value" ref={statAvgDuration}>—</div>
					</div>
				</div>

				<div className="charts-row">
					<div className="chart-card">
						<div className="-header">
							<div className="-title">Token 使用趋势</div>
							<div className="-subtitle" ref={chartTokenSubtitle}>按时间段聚合</div>
						</div>
						<div className="-wrapper">
							<canvas ref={tokenChart}></canvas>
						</div>
					</div>
					<div className="chart-card">
						<div className="-header">
							<div className="-title">成本 & 调用趋势</div>
							<div className="-subtitle" ref={chartCostSubtitle}>按时间段聚合</div>
						</div>
						<div className="-wrapper">
							<canvas ref={costChart}></canvas>
						</div>
					</div>
				</div>

				<div className="table-container">
					<div className="vt table-scroll" ref={$tableScroll}>
						<div className="vt-head" onClick.delegate{".sortable"}={({delegateTarget: th}) => {
							const field = th.dataset.sort;
							if (currentSort.field === field) {
								currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
							} else {
								currentSort.field = field;
								currentSort.direction = 'desc';
							}
							applySort();
						}}>
							<div className="sortable" data-sort="time" style="min-width:140px">时间 <span className="sort-arrow">▾</span></div>
							<div data-sort="provider"><select className="filter-select" ref={$filterProvider} onChange={applyFilters}></select></div>
							<div data-sort="model"><select className="filter-select" ref={$filterModel} onChange={applyFilters}></select></div>
							<div className="sortable" data-sort="input_tokens" style="text-align:right">输入 <span className="sort-arrow">▾</span></div>
							<div className="sortable" data-sort="output_tokens" style="text-align:right">输出 <span className="sort-arrow">▾</span></div>
							<div className="sortable" data-sort="total_tokens" style="text-align:right">总计 <span className="sort-arrow">▾</span></div>
							<div style="text-align:right">缓存</div>
							<div className="sortable" data-sort="cost" style="text-align:right">成本 <span className="sort-arrow">▾</span></div>
							<div className="sortable" data-sort="duration" style="text-align:right">耗时 <span className="sort-arrow">▾</span></div>
							<div className="sortable" data-sort="latency" style="text-align:right">延迟 <span className="sort-arrow">▾</span></div>
							<div data-sort="finish_reason" style={"text-align:center"}><select className="filter-select" ref={$filterFinishReason} onChange={applyFilters}></select></div>
						</div>
						<div className="vt-body" ref={$tableBody}>
							<div className="state-message">
								<div className="spinner"></div>
								<div className="state-title">加载中...</div>
								<div className="state-desc">正在获取调用日志数据</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</>
	};
	setPresetRange('24h', true);
	return state;
}

EVENT_BUS.on(['closeWindow', 'llm-log'], e => {
	allLogs = filteredLogs = [];
	cachedLogs = cachedLogs.slice(-1000);
});

export const openLogViewer = () => {
	openWindow({
		id: "llm-log",
		icon: <i className="ri-bar-chart-box-line" />,
		title: "LLM调用日志",
		width: 1100,
		height: 0.75,
		element: createLogViewer
	});
}
