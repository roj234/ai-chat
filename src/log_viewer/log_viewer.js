import {$foreach, $state, $store, ONCE_EVENT} from "unconscious";
import Chart from "/plugins/tools/chart.async.js";
import {msgpack_schema, msgpack_schema_version} from "/common/MsgpackSchema.js";
import {decodeMsg} from "unconscious/common/msgpack.js";
import {PROTOCOL_VERSION} from "/backend/sync_const.js";
import {formatDate} from "unconscious/common/Utils.js";

// ============ STATE ============
let allLogs = [];
let filteredLogs = [];
let currentPage = 1;
const pageSize = 20;
let currentSort = { field: 'time', direction: 'desc' };
let autoRefreshInterval = null;
let tokenChartInstance = null;
let costChartInstance = null;

// ============ DOM REFS ============
/**
 * @type {HTMLElement}
 */
let $tableBody, $tableScroll, $paginationInfo,
	$paginationBtns, $resultsCount, $refreshIndicator,
	$toast, $startDate, $endDate, $filterProvider,
	$filterModel, $filterFinishReason, $autoRefreshBtn,
	chartCostSubtitle, chartTokenSubtitle, costChart, statAvgDuration,
	statAvgTTFT, statCachedTokens, statCachedTokensSub, statInputTokens,
	statInputTokensSub, statOutputTokens, statReasoningTokens, statTotalCost,
	statTotalCostSub, statTotalRequests, tokenChart;


// ============ UTILS ============
const formatNumber = n => {
	if (n == null || isNaN(n)) return '—';
	if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
	return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatCost = (c, currency) => {
	if (c == null || isNaN(c)) return '—';
	const sym = currency === 'CNY' ? '¥' : '$';
	if (c) {
		if (Math.abs(c) < 0.001) return sym + c.toFixed(6);
		if (Math.abs(c) < 0.01) return sym + c.toFixed(5);
		if (Math.abs(c) < 1) return sym + c.toFixed(4);
	}
	return sym + c.toFixed(3);
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
	if (typeof reason !== "string") return <span className="badge badge-neutral">{reason}</span>;
	const r = reason.toLowerCase();
	if (r === 'stop' || r === 'end_turn') return <span className="badge badge-success">stop</span>;
	if (r === 'length' || r === 'max_tokens') return <span className="badge badge-warning">length</span>;
	if (r.includes('tool')) return <span className="badge badge-info">{reason}</span>;
	if (r === 'error' || r === 'content_filter') return <span className="badge badge-error">{reason}</span>;
	return <span className="badge badge-neutral">{reason}</span>;
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

function showToast(msg, isError = false) {
	$toast.textContent = msg;
	$toast.className = 'toast ' + (isError ? 'error' : '') + ' show';
	clearTimeout($toast._timeout);
	$toast._timeout = setTimeout(() => {
		$toast.className = 'toast';
	}, 2500);
}

// ============ TIME RANGE ============
const getTimeRange = () => [+new Date($startDate.value), +new Date($endDate.value)];

const clearActivePresetBtn = () => {
	document.querySelector('#presetBtns .btn-active')?.classList.remove('btn-active');
};

const setPresetRange = range => {
	clearActivePresetBtn();
	document.querySelector(`#presetBtns [data-range="${range}"]`)?.classList.add('btn-active');

	const end = new Date();
	const start = new Date(end);
	const type = range[range.length-1];
	switch (type) {
		case 'h':
			start.setHours(start.getHours()-parseInt(range, 10));
		break;
		case 'd':
			start.setHours(-parseInt(range, 10) * 24, 0);
			end.setHours(23, 59);
		break;
		case 'm':
			start.setMonth(end.getMonth(), 1);
			start.setHours(0, 0);
			end.setMonth(end.getMonth()+1, 0);
			end.setHours(23, 59);
		break;
	}

	$startDate.value = formatDate("Y-m-dTH:i", start);
	$endDate.value = formatDate("Y-m-dTH:i", end);

	refreshData();
};

const cfg = $store("config", undefined, {persist: true, deep: false});

// ============ API CALL ============
async function makeRequest(url, params) {
	const res = await fetch(url, {
		headers: {
			'Accept': 'application/vnd.msgpack,application/json',
			'Content-Type': 'application/json',
			'x-sv': msgpack_schema_version,
			'x-pv': PROTOCOL_VERSION,
			'Authorization': 'Bearer '+(cfg.db_pat||'')
		},
		...params,
		referrerPolicy: "no-referrer"
	});

	const decode = () => {
		const contentType = res.headers.get('Content-Type');
		if (contentType === 'application/json') return res.json();
		if (contentType === 'application/vnd.msgpack') {
			return res.arrayBuffer().then(ab => {
				return decodeMsg(new DataView(ab), {
					//multiple: true,
					bigint: true,
					schema: msgpack_schema
				});
			});
		}
		return res.text();
	};

	let data = await decode();

	if (!res.ok) {
		if (typeof data !== "string") data = JSON.stringify(data);
		throw new Error(`HTTP ${res.status}\n${data}`);
	}

	return data;
}

function fetchPrices() {
	return makeRequest(cfg.db_server+"database/fetch", { "method": "POST" });
}

async function fetchLogs() {
	const [ start, end ] = getTimeRange();
	const url = cfg.db_server+`logs?start=${start}&end=${end}`;
	const logs = await makeRequest(url);
	for (const item of logs) {
		if (item.currency === "USD") {
			item.cost /= 0.15;
		}
		item.currency = "CNY";
	}
	return logs;
}

// ============ DATA PROCESSING ============
function processLogs(logs) {
	return logs.map(log => ({
		...log,
		total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0) + (log.cached_tokens || 0),
	}));
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

	$filterProvider.innerHTML = '<option value="">全部渠道</option>' +
		[...providers].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
			.join('');
	$filterModel.innerHTML = '<option value="">全部模型</option>' +
		[...models].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join(
			'');
	$filterFinishReason.innerHTML = '<option value="">全部状态</option>' +
		[...finishReasons].sort().map(r =>
			`<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');

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

	$resultsCount.textContent = `共 ${filteredLogs.length} 条记录`;
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
			va = (a.input_tokens || 0) + (a.output_tokens || 0);
			vb = (b.input_tokens || 0) + (b.output_tokens || 0);
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
	const currency = logs.length > 0 ? (logs[0].currency || 'USD') : 'USD';
	const avgDuration = total > 0 ? logs.reduce((s, l) => s + (l.duration || 0), 0) / total : 0;
	const avgTTFT = total > 0 ? logs.reduce((s, l) => s + (l.latency || 0), 0) / total : 0;
	const cacheHitRate = (inputTokens + cachedTokens) > 0 ? cachedTokens / (inputTokens + cachedTokens) *
		100 : 0;

	statTotalRequests.textContent = formatNumber(total);
	statInputTokens.textContent = formatNumber(inputTokens);
	statInputTokensSub.textContent = reasoningTokens > 0 ?
		`平均: ${formatNumber(Math.round(inputTokens / total))}/${formatNumber(Math.round(outputTokens / total))}tok/次` : '';
	statOutputTokens.textContent = formatNumber(outputTokens);

	statReasoningTokens.textContent = `${formatNumber(reasoningTokens)}`;

	statTotalCost.textContent = formatCost(totalCost, currency);
	statTotalCostSub.textContent = total > 0 ?
		`平均: ${formatCost(totalCost / total, currency)}/请求` : '';
	statAvgDuration.textContent = formatDuration(avgDuration);
	statAvgTTFT.textContent = formatDuration(avgTTFT);
	statCachedTokens.textContent = formatNumber(cachedTokens);
	statCachedTokensSub.textContent =
		`缓存命中: ${cacheHitRate.toFixed(1)}% | 写入: ${formatNumber(cacheWriteTokens)}`;
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
	startOfWeek.setDate(d.getDate() - d.getDay());
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
	for (let t = start; t <= end; t += bucketDur) {
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
	}

	// Fill buckets
	logs.forEach(log => {
		const logTime = log.time || 0;
		const label = getBucketLabel(logTime, bucketSize);
		let b = buckets.get(label);
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
	const labels = bucketArr.map(b => b.label);
	const inputData = bucketArr.map(b => b.input_tokens);
	const outputData = bucketArr.map(b => b.output_tokens);
	const reasoningData = bucketArr.map(b => b.reasoning_tokens);
	const cachedData = bucketArr.map(b => b.cached_tokens);
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
		{ label: '缓存', color: '#3cc8c8', data: cachedData },
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
						color: '#6b7385',
						maxRotation: 45,
						font: { size: 10 },
					},
					grid: { color: '#2a304080', drawBorder: false },
				},
				y: {
					ticks: {
						color: '#6b7385',
						font: { size: 10 },
						callback: formatNumber,
					},
					grid: { color: '#2a304080', drawBorder: false },
					beginAtZero: true,
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
					label: '请求',
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
						label: (ctx) => {
							if (ctx.dataset.label.includes('成本')) return `${ctx.dataset.label}: ${formatCost(ctx.raw, currency)}`;
							return `${ctx.dataset.label}: ${formatNumber(ctx.raw)}`;
						},
					},
				},
			},
			scales: {
				x: {
					ticks: { color: '#6b7385', maxRotation: 45, font: { size: 10 }, },
					grid: { color: '#2a304080', drawBorder: false },
				},
				y: {
					type: 'linear',
					position: 'left',
					ticks: {
						color: '#f0a050',
						font: { size: 10 },
						callback: (v) => formatCost(v, currency),
					},
					grid: { color: '#2a304080', drawBorder: false },
					beginAtZero: true,
				},
				y1: {
					type: 'linear',
					position: 'right',
					ticks: {
						color: '#4d94ff',
						font: { size: 10 },
						callback: formatNumber,
					},
					grid: { drawOnChartArea: false, drawBorder: false },
					beginAtZero: true,
				},
			},
		},
	});
}

let renderStartIndex;
const renderLogs = $state();
let foreachTable = $foreach(renderLogs, (log, i) => {
	const currency = log.currency || 'USD';
	const totalTok = (log.input_tokens || 0) + (log.output_tokens || 0);
	const cachedInfo = log.cached_tokens ?
		<span style="color:#3cc8c8" title="缓存命中">{formatNumber(log.cached_tokens)}</span> : '—';

	const makeDetails = () => <tr className="expand-row-detail">
			<td colSpan="11">
				<div className="detail-grid">
					<div className="detail-item">
						<span className="detail-label">ID</span>
						<span className="detail-value">{log.request_id} (#{log.id})</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">Tokens</span>
						<span
							className="detail-value">{log.input_tokens}{log.cached_tokens && `(+${log.cached_tokens} cached)`}↑ {log.output_tokens}{log.reasoning_tokens && `(${log.reasoning_tokens} reasoning)`}↓</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">缓存写入</span>
						<span
							className="detail-value">{log.cache_write_tokens ? log.cache_write_tokens : '—'}</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">延迟与耗时</span>
						<span className="detail-value">{log.latency}ms/{log.duration}ms</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">渠道和模型</span>
						<span className="detail-value">{log.provider}:{log.model}</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">成本</span>
						<span className="detail-value">{formatCost(log.cost, currency)} {(currency)}</span>
					</div>
					<div className="detail-item">
						<span className="detail-label">时间戳</span>
						<span className="detail-value">{new Date(log.time).toISOString()}</span>
					</div>
				</div>
			</td>
		</tr>;

	const self = <tr onClick={() => toggleRow(log, self, makeDetails)}>
		<td className="text-secondary mono" style="font-size:12px">{formatTime(log.time)}</td>
		<td><span style="font-weight:500;color:#c8d0dc">{log.provider || '—'}</span></td>
		<td className="mono" style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;"
			title={log.model}>{log.model}</td>
		<td className="mono" style="text-align:right;color:#8ab4f8">{formatNumber(log.input_tokens)}</td>
		<td className="mono" style="text-align:right;color:#6ddb9e">{formatNumber(log.output_tokens)}</td>
		<td className="mono" style="text-align:right;font-weight:600;color:#e8ecf1">{formatNumber(totalTok)}</td>
		<td className="mono" style="text-align:right;font-size:12px">{cachedInfo}</td>
		<td className="mono"
			style="text-align:right;font-weight:600;color:#f0c060">{formatCost(log.cost, currency)}</td>
		<td className="mono" style="text-align:right;color:#e0a870">{formatDuration(log.duration)}</td>
		<td className="mono" style="text-align:right;color:#e890b0">{formatDuration(log.latency)}</td>
		<td>{getFinishBadge(log.finish_reason)}</td>
	</tr>;
	return self;
});

// ============ TABLE ============
function renderTable() {
	const startIdx = (currentPage - 1) * pageSize;
	const pageLogs = filteredLogs.slice(startIdx, startIdx + pageSize);
	const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));

	if (filteredLogs.length === 0) {
		$tableBody.replaceChildren(
			<tr>
				<td colspan="11">
					<div class="state-message">
						<div class="state-icon">📭</div>
						<div class="state-title">暂无数据</div>
						<div class="state-desc">所选时间范围内没有匹配的请求日志</div>
					</div>
				</td>
			</tr>
		);
	} else {
		renderStartIndex = startIdx;
		renderLogs.value = pageLogs;
		$tableBody.replaceChildren(foreachTable);
	}

	// Pagination
	$paginationInfo.textContent = filteredLogs.length > 0 ?
		`显示 ${startIdx + 1}–${Math.min(startIdx + pageSize, filteredLogs.length)} / 共 ${filteredLogs.length} 条` :
		'无数据';

	let pagBtnsHtml = [];
	pagBtnsHtml.push(<button className="page-btn" onClick={goToPage.bind(null, currentPage - 1)}
							 disabled={currentPage <= 1}>◀</button>);
	const maxVisible = 7;
	let pStart = Math.max(1, currentPage - Math.floor(maxVisible / 2));
	let pEnd = Math.min(totalPages, pStart + maxVisible - 1);
	if (pEnd - pStart < maxVisible - 1) pStart = Math.max(1, pEnd - maxVisible + 1);
	if (pStart > 1) pagBtnsHtml.push(<button className="page-btn" onClick={goToPage.bind(null, 1)}>1</button>);
	if (pStart > 2) pagBtnsHtml.push(<span style="padding:0 4px;color:#6b7385">…</span>);
	for (let p = pStart; p <= pEnd; p++) {
		pagBtnsHtml.push(<button className={`page-btn` + (p === currentPage ? ' active' : '')}
								 onClick={goToPage.bind(null, p)}>{p}</button>);
	}
	if (pEnd < totalPages - 1) pagBtnsHtml.push(<span style="padding:0 4px;color:#6b7385">…</span>);
	if (pEnd < totalPages) pagBtnsHtml.push(<button className="page-btn"
													onClick={goToPage.bind(null, totalPages)}>{totalPages}</button>);
	pagBtnsHtml.push(<button className="page-btn" onClick={goToPage.bind(null, currentPage + 1)}
							 disabled={currentPage >= totalPages}>▶</button>);
	$paginationBtns.replaceChildren(...pagBtnsHtml);

	// Update sort header
	document.querySelectorAll('thead th.sortable').forEach(th => {
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
			const fullLog = (await makeRequest( cfg.db_server+`batch`, {
				method: 'POST',
				body: JSON.stringify([["log/by-rowid", log.rowid]])
			}))[0];
			if (fullLog) Object.assign(log, fullLog);
		}
		const newEl = makeDetails();
		row.insertAdjacentElement("afterend", newEl);
		newEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
	} else {
		row.nextElementSibling.remove();
	}
};

const goToPage = page => {
	const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
	currentPage = Math.max(1, Math.min(page, totalPages));
	renderTable();
	$tableScroll.scrollTop = 0;
};

const toggleAutoRefresh = () => {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
		$autoRefreshBtn.classList.remove('btn-active');
	} else {
		autoRefreshInterval = setInterval(refreshData, 30000);
		$autoRefreshBtn.classList.add('btn-active');
		showToast('自动刷新已开启（30秒间隔）');
	}
};

const refreshData = async () => {
	$refreshIndicator.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid #6b7385;border-top-color:#4d94ff;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:4px;"></span> 加载中...';
	try {
		const logs = await fetchLogs();
		allLogs = processLogs(logs);
		updateFilters();
		applyFilters();
		const now = new Date();
		$refreshIndicator.innerHTML = `更新于 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
		showToast(`成功加载 ${logs.length} 条日志`);
	} catch (err) {
		console.error('获取日志失败:', err);
		$refreshIndicator.innerHTML = '<span style="color:#e0556a">⚠ 加载失败</span>';
		showToast('加载失败: ' + err.message, true);
		if (allLogs.length === 0) {
			$tableBody.replaceChildren(<tr>
				<td colSpan="11">
					<div className="state-message">
						<div className="state-icon">⚠️</div>
						<div className="state-title">加载失败</div>
						<div className="state-desc">${escapeHtml(err.message)}</div>
						<button className="btn btn-sm btn-primary" onClick={refreshData} style="margin-top:8px">🔄
							重试
						</button>
					</div>
				</td>
			</tr>);
			statTotalRequests.textContent =
			statInputTokens.textContent =
			statOutputTokens.textContent =
			statTotalCost.textContent =
			statAvgDuration.textContent =
			statAvgTTFT.textContent =
			statCachedTokens.textContent = '—';
		}
	}
};

// ============ EVENT LISTENERS ============

const topBar = () => {
	return (
		<div className="top-bar">
			<span className="top-bar-label">时间范围</span>
			<div className="btn-group" id="presetBtns" onClick.delegate{"button"}={({delegateTarget: btn}) => {
				const range = btn.dataset.range;
				if (range) setPresetRange(range);
			}
			}>
				<button className="btn btn-sm" data-range="1h">1小时</button>
				<button className="btn btn-sm" data-range="24h">24小时</button>
				<button className="btn btn-sm" data-range="1d">今天</button>
				<button className="btn btn-sm" data-range="7d">7天</button>
				<button className="btn btn-sm" data-range="1m">本月</button>
			</div>
			<input type="datetime-local" className="date-input" ref={$startDate} title="开始时间"
				   onChange={() => {
					   clearActivePresetBtn();
					   refreshData();
				   }}
			/>
			<span className="date-separator">—</span>
			<input type="datetime-local" className="date-input" ref={$endDate} title="结束时间"
				   onChange={() => {
					   clearActivePresetBtn();
					   refreshData();
				   }}
			/>
			<span className="top-bar-spacer"></span>
			<span className="refresh-indicator" ref={$refreshIndicator}></span>
			<button className="btn btn-sm btn-ghost" onClick={toggleAutoRefresh} ref={$autoRefreshBtn}
					title="自动刷新">
				<span>⏱️</span> 自动
			</button>
			<button className="btn btn-sm" onClick={({target}) => {
				target.disabled = true;
				fetchPrices().then(refreshData).finally(() => {
					target.disabled = false;
				})
			}} title="刷新数据">
				<span>🔄</span> 刷新
			</button>
		</div>
	);
}
const statsGrid = () => {
	return (
		<div className="stats-grid">
			<div className="stat-card">
				<div className="stat-icon stat-icon-blue">📊</div>
				<div className="stat-sub">请求次数</div>
				<div className="stat-value" ref={statTotalRequests}>—</div>
				<div className="stat-sub" ref={statInputTokensSub}></div>
			</div>
			<div className="stat-card">
				<div className="stat-icon stat-icon-green">📥</div>
				<div className="stat-sub" style="font-size: 14px">输入 Tokens</div>
				<span className="stat-value" ref={statInputTokens}>—</span>/<span ref={statCachedTokens}>—</span>
				<div className="stat-sub" ref={statCachedTokensSub}></div>
			</div>
			<div className="stat-card">
				<div className="stat-icon stat-icon-purple">📤</div>
				<div className="stat-sub" style="font-size: 14px">输出 Tokens</div>
				<span className="stat-value" ref={statOutputTokens}>—</span>/<span ref={statReasoningTokens}>—</span>
			</div>
			<div className="stat-card">
				<div className="stat-icon stat-icon-cyan">💰</div>
				<div className="stat-sub">总成本</div>
				<div className="stat-value" ref={statTotalCost}>—</div>
				<div className="stat-sub" ref={statTotalCostSub}></div>
			</div>
			<div className="stat-card">
				<div className="stat-icon stat-icon-pink">⚡</div>
				<div className="stat-label">平均延迟</div>
				<div className="stat-value" ref={statAvgTTFT}>—</div>
			</div>
			<div className="stat-card">
				<div className="stat-icon stat-icon-orange">⏳</div>
				<div className="stat-label">平均耗时</div>
				<div className="stat-value" ref={statAvgDuration}>—</div>
			</div>
		</div>
	);
}
const chartCard = () => {
	return (
		<div className="charts-row">
			<div className="chart-card">
				<div className="chart-header">
					<div>
						<div className="chart-title">Token 使用趋势</div>
						<div className="chart-subtitle" ref={chartTokenSubtitle}>按时间段聚合</div>
					</div>
				</div>
				<div className="chart-wrapper">
					<canvas ref={tokenChart}></canvas>
				</div>
			</div>
			<div className="chart-card">
				<div className="chart-header">
					<div>
						<div className="chart-title">成本 & 请求趋势</div>
						<div className="chart-subtitle" ref={chartCostSubtitle}>按时间段聚合</div>
					</div>
				</div>
				<div className="chart-wrapper">
					<canvas ref={costChart}></canvas>
				</div>
			</div>
		</div>
	);
}
const filterRow = () => {
	return (
		<div className="filters-row">
			<span className="filter-label">筛选：</span>
			<select className="filter-select" ref={$filterProvider} onChange={applyFilters}></select>
			<select className="filter-select" ref={$filterModel} onChange={applyFilters}></select>
			<select className="filter-select" ref={$filterFinishReason} onChange={applyFilters}></select>
			<span className="results-count" ref={$resultsCount}></span>
		</div>
	);
}
const tableScroll = () => {
	return (
		<div className="table-container">
			<div className="table-scroll" ref={$tableScroll}>
				<table>
					<thead>
					<tr onClick.delegate{"th.sortable"}={({delegateTarget: th}) => {
							const field = th.dataset.sort;
							if (currentSort.field === field) {
								currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
							} else {
								currentSort.field = field;
								currentSort.direction = 'desc';
							}
							applySort();
						}
					}>
						<th className="sortable" data-sort="time" style="min-width:140px">时间 <span
							className="sort-arrow">▾</span></th>
						<th data-sort="provider">渠道</th>
						<th data-sort="model">模型</th>
						<th className="sortable" data-sort="input_tokens" style="text-align:right">输入 <span
							className="sort-arrow">▾</span></th>
						<th className="sortable" data-sort="output_tokens" style="text-align:right">输出 <span
							className="sort-arrow">▾</span></th>
						<th className="sortable" data-sort="total_tokens" style="text-align:right">总计 <span
							className="sort-arrow">▾</span></th>
						<th style="text-align:right">缓存</th>
						<th className="sortable" data-sort="cost" style="text-align:right">成本 <span
							className="sort-arrow">▾</span></th>
						<th className="sortable" data-sort="duration" style="text-align:right">耗时 <span
							className="sort-arrow">▾</span></th>
						<th className="sortable" data-sort="latency" style="text-align:right">延迟 <span
							className="sort-arrow">▾</span></th>
						<th data-sort="finish_reason">状态</th>
					</tr>
					</thead>
					<tbody ref={$tableBody}>
					<tr>
						<td colSpan="11">
							<div className="state-message">
								<div className="spinner"></div>
								<div className="state-title">加载中...</div>
								<div className="state-desc">正在获取请求日志数据</div>
							</div>
						</td>
					</tr>
					</tbody>
				</table>
			</div>
			<div className="pagination-row">
				<span className="pagination-info" ref={$paginationInfo}></span>
				<div className="pagination-btns" ref={$paginationBtns}></div>
			</div>
		</div>
	);
}

// ============ INIT ============
addEventListener("load", () => {
	const app = <>
		<div className="main-container">
			{topBar()}
			{statsGrid()}
			{chartCard()}
			{filterRow()}
			{tableScroll()}
		</div>
		<div className="toast" ref={$toast}></div>
	</>;

	document.body.replaceChildren(...app);
	setPresetRange('24h');
}, ONCE_EVENT);
