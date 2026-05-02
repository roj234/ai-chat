import {
	BarController,
	BarElement,
	CategoryScale,
	Chart,
	Filler,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	PieController,
	PointElement,
	Title,
	Tooltip
} from "chart.js";
Chart.register(
	BarController,
	BarElement,
	CategoryScale,
	Filler,
	Legend,
	LinearScale,
	LineController,
	LineElement,
	PieController,
	PointElement,
	Tooltip,
	Title
);

// ============ STATE ============
let allLogs = [];
let filteredLogs = [];
let currentPage = 1;
const pageSize = 50;
let currentSort = { field: 'time', direction: 'desc' };
let expandedRowId = null;
let autoRefreshInterval = null;
let tokenChartInstance = null;
let costChartInstance = null;
let selectedPresetRange = '7d';
let customStart = null;
let customEnd = null;

// ============ DOM REFS ============
const $tableBody = document.getElementById('tableBody');
const $tableScroll = document.getElementById('tableScroll');
const $paginationInfo = document.getElementById('paginationInfo');
const $paginationBtns = document.getElementById('paginationBtns');
const $resultsCount = document.getElementById('resultsCount');
const $refreshIndicator = document.getElementById('refreshIndicator');
const $toast = document.getElementById('toast');
const $startDate = document.getElementById('startDate');
const $endDate = document.getElementById('endDate');
const $filterProvider = document.getElementById('filterProvider');
const $filterPreset = document.getElementById('filterPreset');
const $filterFinishReason = document.getElementById('filterFinishReason');
const $autoRefreshBtn = document.getElementById('autoRefreshBtn');

// ============ UTILS ============
function formatNumber(n) {
	if (n == null || isNaN(n)) return '—';
	if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
	return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatCost(c, currency) {
	if (c == null || isNaN(c)) return '—';
	const sym = currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
	if (Math.abs(c) < 0.001) return sym + c.toFixed(6);
	if (Math.abs(c) < 0.01) return sym + c.toFixed(5);
	if (Math.abs(c) < 1) return sym + c.toFixed(4);
	return sym + c.toFixed(3);
}

function formatLatency(ms) {
	if (ms == null || isNaN(ms)) return '—';
	if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
	return Math.round(ms) + 'ms';
}

function formatTime(ts) {
	if (!ts) return '—';
	const d = new Date(ts);
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	const hh = String(d.getHours()).padStart(2, '0');
	const min = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	if (isToday) return `今天 ${hh}:${min}:${ss}`;
	return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function getFinishBadge(reason) {
	if (!reason) return '<span class="badge badge-neutral">未知</span>';
	const r = reason.toLowerCase();
	if (r === 'stop' || r === 'end_turn') return '<span class="badge badge-success">stop</span>';
	if (r === 'length' || r === 'max_tokens') return '<span class="badge badge-warning">length</span>';
	if (r.includes('tool')) return '<span class="badge badge-info">' + escapeHtml(reason) +
		'</span>';
	if (r === 'error' || r === 'content_filter') return '<span class="badge badge-error">' +
		escapeHtml(reason) + '</span>';
	return '<span class="badge badge-neutral">' + escapeHtml(reason) + '</span>';
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

function truncate(str, maxLen = 30) {
	if (!str) return '—';
	if (str.length <= maxLen) return escapeHtml(str);
	return '<span class="truncate" title="' + escapeHtml(str) + '">' + escapeHtml(str) + '</span>';
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
function getTimeRange() {
	const now = Date.now();
	let start, end;
	if (selectedPresetRange === 'custom' && customStart && customEnd) {
		start = customStart;
		end = customEnd;
	} else {
		switch (selectedPresetRange) {
			case '1h':
				start = now - 3600 * 1000;
				break;
			case '24h':
				start = now - 86400 * 1000;
				break;
			case '7d':
				start = now - 7 * 86400 * 1000;
				break;
			case '30d':
				start = now - 30 * 86400 * 1000;
				break;
			default:
				start = now - 7 * 86400 * 1000;
		}
		end = now;
	}
	return { start, end };
}

function updateDateInputs() {
	const { start, end } = getTimeRange();
	$startDate.value = new Date(start).toISOString().slice(0, 16);
	$endDate.value = new Date(end).toISOString().slice(0, 16);
}

function setPresetRange(range) {
	selectedPresetRange = range;
	document.querySelectorAll('#presetBtns .btn').forEach(b => b.classList.remove('btn-active'));
	const btn = document.querySelector(`#presetBtns [data-range="${range}"]`);
	if (btn) btn.classList.add('btn-active');
	if (range === 'custom') {
		$startDate.style.opacity = '1';
		$endDate.style.opacity = '1';
		$startDate.disabled = false;
		$endDate.disabled = false;
		if (!customStart) {
			const { start, end } = getTimeRange();
			customStart = start;
			customEnd = end;
		}
	} else {
		$startDate.style.opacity = '0.6';
		$endDate.style.opacity = '0.6';
		$startDate.disabled = true;
		$endDate.disabled = true;
		customStart = null;
		customEnd = null;
	}
	updateDateInputs();
	refreshData();
}

// ============ API CALL ============
async function fetchLogs() {
	const { start, end } = getTimeRange();
	const url = `https://192.168.1.2/aichat/v2/roj234/logs?start=${start}&end=${end}`;
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
	}
	const data = await resp.json();
	if (!Array.isArray(data)) {
		throw new Error('API 返回数据格式不正确，期望数组');
	}
	return data;
}

// ============ DATA PROCESSING ============
function processLogs(logs) {
	return logs.map(log => ({
		...log,
		total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0) + (log
			.reasoning_tokens || 0),
		has_cache: !!(log.cached_tokens || log.cache_write_tokens),
	}));
}

function updateFilters() {
	const providers = new Set();
	const presets = new Set();
	const finishReasons = new Set();
	allLogs.forEach(log => {
		if (log.provider) providers.add(log.provider);
		if (log.preset_id) presets.add(log.preset_id);
		if (log.finish_reason) finishReasons.add(log.finish_reason);
	});

	const currentProv = $filterProvider.value;
	const currentPreset = $filterPreset.value;
	const currentFR = $filterFinishReason.value;

	$filterProvider.innerHTML = '<option value="">全部 Provider</option>' +
		[...providers].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
			.join('');
	$filterPreset.innerHTML = '<option value="">全部 Preset</option>' +
		[...presets].sort().map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join(
			'');
	$filterFinishReason.innerHTML = '<option value="">全部状态</option>' +
		[...finishReasons].sort().map(r =>
			`<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');

	$filterProvider.value = [...providers].includes(currentProv) ? currentProv : '';
	$filterPreset.value = [...presets].includes(currentPreset) ? currentPreset : '';
	$filterFinishReason.value = [...finishReasons].includes(currentFR) ? currentFR : '';
}

function applyFilters() {
	const provFilter = $filterProvider.value;
	const presetFilter = $filterPreset.value;
	const frFilter = $filterFinishReason.value;

	filteredLogs = allLogs.filter(log => {
		if (provFilter && log.provider !== provFilter) return false;
		if (presetFilter && log.preset_id !== presetFilter) return false;
		if (frFilter && log.finish_reason !== frFilter) return false;
		return true;
	});

	// Sort
	const sf = currentSort.field;
	const sd = currentSort.direction;
	filteredLogs.sort((a, b) => {
		let va = a[sf];
		let vb = b[sf];
		if (sf === 'total_tokens') {
			va = (a.input_tokens || 0) + (a.output_tokens || 0) + (a.reasoning_tokens || 0);
			vb = (b.input_tokens || 0) + (b.output_tokens || 0) + (b.reasoning_tokens || 0);
		}
		if (va == null) va = 0;
		if (vb == null) vb = 0;
		if (typeof va === 'string') va = va.toLowerCase();
		if (typeof vb === 'string') vb = vb.toLowerCase();
		if (va < vb) return sd === 'asc' ? -1 : 1;
		if (va > vb) return sd === 'asc' ? 1 : -1;
		return 0;
	});

	currentPage = Math.min(currentPage, Math.max(1, Math.ceil(filteredLogs.length / pageSize)));
	if (filteredLogs.length === 0) currentPage = 1;
	updateStats();
	updateCharts();
	renderTable();
	$resultsCount.textContent = `共 ${filteredLogs.length} 条记录`;
}

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
	const avgLatency = total > 0 ? logs.reduce((s, l) => s + (l.latency || 0), 0) / total : 0;
	const avgTTFT = total > 0 ? logs.reduce((s, l) => s + (l.ttft || 0), 0) / total : 0;
	const cacheHitRate = (inputTokens + cachedTokens) > 0 ? cachedTokens / (inputTokens + cachedTokens) *
		100 : 0;

	document.getElementById('statTotalRequests').textContent = formatNumber(total);
	document.getElementById('statInputTokens').textContent = formatNumber(inputTokens);
	document.getElementById('statInputTokensSub').textContent = reasoningTokens > 0 ?
		`含推理: ${formatNumber(reasoningTokens)}` : '';
	document.getElementById('statOutputTokens').textContent = formatNumber(outputTokens);
	document.getElementById('statOutputTokensSub').textContent = total > 0 ?
		`平均: ${formatNumber(Math.round(outputTokens / total))}/请求` : '';
	document.getElementById('statTotalCost').textContent = formatCost(totalCost, currency);
	document.getElementById('statTotalCostSub').textContent = total > 0 ?
		`平均: ${formatCost(totalCost / total, currency)}/请求` : '';
	document.getElementById('statAvgLatency').textContent = formatLatency(avgLatency);
	document.getElementById('statAvgLatencySub').textContent = total > 0 ? `${total} 次请求` : '';
	document.getElementById('statAvgTTFT').textContent = formatLatency(avgTTFT);
	document.getElementById('statAvgTTFTSub').textContent = '首 Token 时间';
	document.getElementById('statCachedTokens').textContent = formatNumber(cachedTokens);
	document.getElementById('statCachedTokensSub').textContent =
		`命中率: ${cacheHitRate.toFixed(1)}% | 写入: ${formatNumber(cacheWriteTokens)}`;
}

// ============ CHARTS ============
function getBucketSize() {
	const { start, end } = getTimeRange();
	const rangeSec = end - start;
	if (rangeSec <= 2 * 3600 * 1000) return 'minute'; // <=2 hours: minute
	if (rangeSec <= 2 * 86400 * 1000) return 'hour'; // <=2 days: hourly
	if (rangeSec <= 60 * 86400 * 1000) return 'day'; // <=60 days: daily
	return 'week';
}

function getBucketLabel(ts, bucketSize) {
	const d = new Date(ts);
	if (bucketSize === 'minute') {
		return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
	}
	if (bucketSize === 'hour') {
		return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
	}
	if (bucketSize === 'day') {
		return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
	}
	// week
	const startOfWeek = new Date(d);
	startOfWeek.setDate(d.getDate() - d.getDay());
	return `${String(startOfWeek.getMonth()+1).padStart(2,'0')}-${String(startOfWeek.getDate()).padStart(2,'0')} 周`;
}

function aggregateLogs(logs) {
	const bucketSize = getBucketSize();
	const { start, end } = getTimeRange();
	const buckets = new Map();

	// Determine bucket duration in seconds
	let bucketDur;
	if (bucketSize === 'hour') bucketDur = 3600 * 1000;
	else if (bucketSize === 'minute') bucketDur = 60 * 1000;
	else if (bucketSize === 'day') bucketDur = 86400 * 1000;
	else bucketDur = 7 * 86400 * 1000;

	// Create empty buckets
	let bucketStart = start - (start % bucketDur);
	for (let t = bucketStart; t <= end; t += bucketDur) {
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
		const bucketTs = logTime - (logTime % bucketDur);
		const label = getBucketLabel(bucketTs, bucketSize);
		const b = buckets.get(label);
		if (b) {
			b.input_tokens += (log.input_tokens || 0);
			b.output_tokens += (log.output_tokens || 0);
			b.reasoning_tokens += (log.reasoning_tokens || 0);
			b.cached_tokens += (log.cached_tokens || 0);
			b.cache_write_tokens += (log.cache_write_tokens || 0);
			b.cost += (log.cost || 0);
			b.requests += 1;
		}
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
	document.getElementById('chartTokenSubtitle').textContent = `按${bucketLabelZh}聚合`;
	document.getElementById('chartCostSubtitle').textContent = `按${bucketLabelZh}聚合`;

	// Token chart
	if (tokenChartInstance) tokenChartInstance.destroy();
	const tokenCtx = document.getElementById('tokenChart').getContext('2d');
	const datasets = [];
	const colors = [
		{ label: 'Input Tokens', color: '#4d94ff', data: inputData },
		{ label: 'Output Tokens', color: '#3db87b', data: outputData },
		{ label: 'Cached Tokens', color: '#3cc8c8', data: cachedData },
	];
	if (reasoningData.some(v => v > 0)) {
		colors.splice(2, 0, { label: 'Reasoning Tokens', color: '#9b7ef0', data: reasoningData });
	}
	colors.forEach((c, i) => {
		datasets.push({
			label: c.label,
			data: c.data,
			borderColor: c.color,
			backgroundColor: c.color + '20',
			borderWidth: 2,
			fill: i === 0,
			tension: 0.35,
			pointRadius: bucketArr.length <= 48 ? 3 : 1,
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
						pointStyleWidth: 8,
						padding: 20,
						font: { size: 11 },
						boxWidth: 8,
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
						maxTicksLimit: 20,
					},
					grid: { color: '#2a304020', drawBorder: false },
				},
				y: {
					ticks: {
						color: '#6b7385',
						font: { size: 10 },
						callback: (v) => formatNumber(v),
					},
					grid: { color: '#2a304030', drawBorder: false },
					beginAtZero: true,
				},
			},
		},
	});

	// Cost chart
	if (costChartInstance) costChartInstance.destroy();
	const costCtx = document.getElementById('costChart').getContext('2d');
	const currency = filteredLogs.length > 0 ? (filteredLogs[0].currency || 'USD') : 'USD';
	const currencySym = currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : '$';
	costChartInstance = new Chart(costCtx, {
		type: 'bar',
		data: {
			labels,
			datasets: [
				{
					label: '成本 (' + currencySym + ')',
					data: costData,
					backgroundColor: costData.map((v, i) => {
						const ratio = costData.length > 0 ? i / costData.length : 0;
						return `rgba(240,160,80,${0.4 + ratio * 0.4})`;
					}),
					borderColor: '#f0a050',
					borderWidth: 1,
					borderRadius: 4,
					yAxisID: 'y',
					order: 2,
				},
				{
					label: '请求数',
					data: requestData,
					type: 'line',
					borderColor: '#4d94ff',
					backgroundColor: 'transparent',
					borderWidth: 2,
					tension: 0.35,
					pointRadius: bucketArr.length <= 48 ? 3 : 1,
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
						pointStyleWidth: 8,
						padding: 20,
						font: { size: 11 },
						boxWidth: 8,
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
					ticks: { color: '#6b7385', maxRotation: 45, font: { size: 10 },
						maxTicksLimit: 20 },
					grid: { color: '#2a304020', drawBorder: false },
				},
				y: {
					type: 'linear',
					position: 'left',
					ticks: {
						color: '#f0a050',
						font: { size: 10 },
						callback: (v) => formatCost(v, currency),
					},
					grid: { color: '#2a304030', drawBorder: false },
					beginAtZero: true,
				},
				y1: {
					type: 'linear',
					position: 'right',
					ticks: {
						color: '#4d94ff',
						font: { size: 10 },
						callback: (v) => formatNumber(v),
					},
					grid: { drawOnChartArea: false, drawBorder: false },
					beginAtZero: true,
				},
			},
		},
	});
}

// ============ TABLE ============
function renderTable() {
	const startIdx = (currentPage - 1) * pageSize;
	const pageLogs = filteredLogs.slice(startIdx, startIdx + pageSize);
	const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));

	if (filteredLogs.length === 0) {
		$tableBody.innerHTML = `
                <tr>
                  <td colspan="11">
                    <div class="state-message">
                      <div class="state-icon">📭</div>
                      <div class="state-title">暂无数据</div>
                      <div class="state-desc">所选时间范围内没有匹配的请求日志</div>
                    </div>
                  </td>
                </tr>`;
	} else {
		$tableBody.innerHTML = pageLogs.map((log, i) => {
			const globalIdx = startIdx + i;
			const rowId = 'row-' + globalIdx;
			const isExpanded = expandedRowId === rowId;
			const currency = log.currency || 'USD';
			const totalTok = (log.input_tokens || 0) + (log.output_tokens || 0) + (log
				.reasoning_tokens || 0);
			const cachedInfo = log.cached_tokens ?
				`<span style="color:#3cc8c8" title="缓存命中">${formatNumber(log.cached_tokens)}</span>` :
				'—';
			if (log.cache_write_tokens && !log.cached_tokens) {
				// show write only
			}

			let rowHtml = `
                  <tr id="${rowId}" class="${isExpanded ? 'expanded' : ''}" onclick="toggleRow('${rowId}', ${globalIdx})">
                    <td class="text-secondary mono" style="font-size:12px">${formatTime(log.time)}</td>
                    <td><span style="font-weight:500;color:#c8d0dc">${escapeHtml(log.provider || '—')}</span></td>
                    <td class="mono" style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(log.preset_id || '')}">${escapeHtml(log.preset_id || '—')}</td>
                    <td class="mono" style="text-align:right;color:#8ab4f8">${formatNumber(log.input_tokens)}</td>
                    <td class="mono" style="text-align:right;color:#6ddb9e">${formatNumber(log.output_tokens)}</td>
                    <td class="mono" style="text-align:right;font-weight:600;color:#e8ecf1">${formatNumber(totalTok)}</td>
                    <td class="mono" style="text-align:right;font-size:12px">${cachedInfo}</td>
                    <td class="mono" style="text-align:right;font-weight:600;color:#f0c060">${formatCost(log.cost, currency)}</td>
                    <td class="mono" style="text-align:right;color:#e0a870">${formatLatency(log.latency)}</td>
                    <td class="mono" style="text-align:right;color:#e890b0">${formatLatency(log.ttft)}</td>
                    <td>${getFinishBadge(log.finish_reason)}</td>
                  </tr>`;

			if (isExpanded) {
				rowHtml += `
                  <tr class="expand-row-detail" id="${rowId}-detail">
                    <td colspan="11">
                      <div class="detail-grid">
                        <div class="detail-item">
                          <span class="detail-label">Request ID</span>
                          <span class="detail-value">${escapeHtml(log.request_id || '—')}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Message ID</span>
                          <span class="detail-value">${log.message_id != null ? log.message_id : '—'}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Preset ID</span>
                          <span class="detail-value">${escapeHtml(log.preset_id || '—')}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Provider</span>
                          <span class="detail-value">${escapeHtml(log.provider || '—')}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Input Tokens</span>
                          <span class="detail-value">${formatNumber(log.input_tokens)}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Output Tokens</span>
                          <span class="detail-value">${formatNumber(log.output_tokens)}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Reasoning Tokens</span>
                          <span class="detail-value">${log.reasoning_tokens != null ? formatNumber(log.reasoning_tokens) : '—'}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Cached Tokens</span>
                          <span class="detail-value">${log.cached_tokens != null ? formatNumber(log.cached_tokens) : '—'}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Cache Write Tokens</span>
                          <span class="detail-value">${log.cache_write_tokens != null ? formatNumber(log.cache_write_tokens) : '—'}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Latency</span>
                          <span class="detail-value">${formatLatency(log.latency)}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">TTFT</span>
                          <span class="detail-value">${formatLatency(log.ttft)}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Finish Reason</span>
                          <span class="detail-value">${escapeHtml(log.finish_reason || '—')}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">Cost</span>
                          <span class="detail-value">${formatCost(log.cost, currency)} ${escapeHtml(currency)}</span>
                        </div>
                        <div class="detail-item">
                          <span class="detail-label">时间戳</span>
                          <span class="detail-value">${log.time || '—'}</span>
                        </div>
                      </div>
                    </td>
                  </tr>`;
			}
			return rowHtml;
		}).join('');
	}

	// Pagination
	$paginationInfo.textContent = filteredLogs.length > 0 ?
		`显示 ${startIdx + 1}–${Math.min(startIdx + pageSize, filteredLogs.length)} / 共 ${filteredLogs.length} 条` :
		'无数据';
	let pagBtnsHtml = '';
	pagBtnsHtml +=
		`<button class="page-btn" onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>◀</button>`;
	const maxVisible = 7;
	let pStart = Math.max(1, currentPage - Math.floor(maxVisible / 2));
	let pEnd = Math.min(totalPages, pStart + maxVisible - 1);
	if (pEnd - pStart < maxVisible - 1) pStart = Math.max(1, pEnd - maxVisible + 1);
	if (pStart > 1) pagBtnsHtml += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
	if (pStart > 2) pagBtnsHtml += `<span style="padding:0 4px;color:#6b7385">…</span>`;
	for (let p = pStart; p <= pEnd; p++) {
		pagBtnsHtml +=
			`<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
	}
	if (pEnd < totalPages - 1) pagBtnsHtml +=
		`<span style="padding:0 4px;color:#6b7385">…</span>`;
	if (pEnd < totalPages) pagBtnsHtml +=
		`<button class="page-btn" onclick="goToPage(${totalPages})">${totalPages}</button>`;
	pagBtnsHtml +=
		`<button class="page-btn" onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>▶</button>`;
	$paginationBtns.innerHTML = pagBtnsHtml;

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
window.toggleRow = function(rowId, globalIdx) {
	if (expandedRowId === rowId) {
		expandedRowId = null;
	} else {
		expandedRowId = rowId;
	}
	renderTable();
	// Scroll to the row if expanding
	if (expandedRowId) {
		setTimeout(() => {
			const el = document.getElementById(rowId);
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}, 50);
	}
};

window.goToPage = function(page) {
	const totalPages = Math.max(1, Math.ceil(filteredLogs.length / pageSize));
	currentPage = Math.max(1, Math.min(page, totalPages));
	expandedRowId = null;
	renderTable();
	$tableScroll.scrollTop = 0;
};

window.toggleAutoRefresh = function() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
		$autoRefreshBtn.classList.remove('btn-active');
		$refreshIndicator.innerHTML = '<span class="refresh-dot" style="background:#6b7385"></span> 自动刷新已关闭';
		showToast('自动刷新已关闭');
	} else {
		autoRefreshInterval = setInterval(refreshData, 30000);
		$autoRefreshBtn.classList.add('btn-active');
		$refreshIndicator.innerHTML =
			'<span class="refresh-dot"></span> 每30秒自动刷新';
		showToast('自动刷新已开启（30秒间隔）');
	}
};

window.refreshData = async function() {
	$refreshIndicator.innerHTML =
		'<span style="display:inline-block;width:14px;height:14px;border:2px solid #6b7385;border-top-color:#4d94ff;border-radius:50%;animation:spin 0.6s linear infinite;vertical-align:middle;margin-right:4px;"></span> 加载中...';
	try {
		const logs = await fetchLogs();
		allLogs = processLogs(logs);
		updateFilters();
		applyFilters();
		const now = new Date();
		$refreshIndicator.innerHTML =
			`<span class="refresh-dot"></span> 更新于 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
		showToast(`成功加载 ${logs.length} 条日志`);
	} catch (err) {
		console.error('获取日志失败:', err);
		$refreshIndicator.innerHTML = '<span style="color:#e0556a">⚠ 加载失败</span>';
		showToast('加载失败: ' + err.message, true);
		if (allLogs.length === 0) {
			$tableBody.innerHTML = `
                  <tr>
                    <td colspan="11">
                      <div class="state-message">
                        <div class="state-icon">⚠️</div>
                        <div class="state-title">加载失败</div>
                        <div class="state-desc">${escapeHtml(err.message)}</div>
                        <button class="btn btn-sm btn-primary" onclick="refreshData()" style="margin-top:8px">🔄 重试</button>
                      </div>
                    </td>
                  </tr>`;
			document.getElementById('statTotalRequests').textContent = '—';
			document.getElementById('statInputTokens').textContent = '—';
			document.getElementById('statOutputTokens').textContent = '—';
			document.getElementById('statTotalCost').textContent = '—';
			document.getElementById('statAvgLatency').textContent = '—';
			document.getElementById('statAvgTTFT').textContent = '—';
			document.getElementById('statCachedTokens').textContent = '—';
		}
	}
};

// ============ EVENT LISTENERS ============
// Preset buttons
document.getElementById('presetBtns').addEventListener('click', (e) => {
	const btn = e.target.closest('button');
	if (!btn) return;
	const range = btn.dataset.range;
	if (range) setPresetRange(range);
});

// Custom date inputs
$startDate.addEventListener('change', () => {
	if ($startDate.value) {
		customStart = new Date($startDate.value).getTime();
		if (selectedPresetRange !== 'custom') {
			selectedPresetRange = 'custom';
			document.querySelectorAll('#presetBtns .btn').forEach(b => b.classList.remove(
				'btn-active'));
			const customBtn = document.querySelector('#presetBtns [data-range="custom"]');
			if (customBtn) customBtn.classList.add('btn-active');
			$startDate.disabled = false;
			$endDate.disabled = false;
			$startDate.style.opacity = '1';
			$endDate.style.opacity = '1';
		}
	}
});
$endDate.addEventListener('change', () => {
	if ($endDate.value) {
		customEnd = new Date($endDate.value).getTime();
		if (selectedPresetRange !== 'custom') {
			selectedPresetRange = 'custom';
			document.querySelectorAll('#presetBtns .btn').forEach(b => b.classList.remove(
				'btn-active'));
			const customBtn = document.querySelector('#presetBtns [data-range="custom"]');
			if (customBtn) customBtn.classList.add('btn-active');
			$startDate.disabled = false;
			$endDate.disabled = false;
			$startDate.style.opacity = '1';
			$endDate.style.opacity = '1';
		}
	}
});

// Custom range button applies the dates
document.querySelector('#presetBtns [data-range="custom"]').addEventListener('click', () => {
	if (customStart && customEnd) {
		refreshData();
	} else {
		const { start, end } = getTimeRange();
		customStart = start;
		customEnd = end;
		updateDateInputs();
		refreshData();
	}
});

// Sortable headers
document.querySelectorAll('thead th.sortable').forEach(th => {
	th.addEventListener('click', () => {
		const field = th.dataset.sort;
		if (currentSort.field === field) {
			currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
		} else {
			currentSort.field = field;
			currentSort.direction = 'desc';
		}
		expandedRowId = null;
		applyFilters();
	});
});

// ============ INIT ============
function init() {
	updateDateInputs();
	$startDate.disabled = true;
	$endDate.disabled = true;
	$startDate.style.opacity = '0.6';
	$endDate.style.opacity = '0.6';
	refreshData();
}

init();

window.applyFilters = applyFilters;