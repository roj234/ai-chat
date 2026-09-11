import {$computed, $state, unconscious} from "unconscious";
import {LOG_CACHE, messages} from "../states.js";
import {getBillingLog} from "../database.js";
import {LLM_COST_SCALE} from "/backend/sync.js";
import {Icon_lightning} from "./Icons.jsx";
import {formatDuration} from "../../common/pure-utils.js";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";

const formatKM = size => {
	if (size > 1000000) return (size / 1000000) . toFixed(2) + 'M';
	if (size > 1000) return (size / 1000) . toFixed(2) + 'K';
	return size;
}

/**
 *
 * @param {AiChat.MessageListItem} m
 * @return {JSX.Element}
 * @constructor
 */
export const UsageBlock = (m) => {
	const logData = $state("");

	const msgs = messages.slice(m.index, m.end_index);

	// FIXME UsageBlock在finish_reason被设置后就会渲染，与api-request触发保存之间提前了一个微任务，导致getLog请求排在同一batch的最前方
	queueMacrotask(() => {
		const p = [];

		msgs.forEach(m => {
			if (!m[LOG_CACHE]) p.push(getBillingLog(m.id).then(log => m[LOG_CACHE] = log, () => {}));
		});

		Promise.all(p).then(() => {
			let totalInput = 0;
			let totalCacheRead = 0;
			let totalOutput = 0;
			let totalReasoning = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;
			let totalTime = 0;

			let first;
			msgs.forEach(item => {
				const log = item[LOG_CACHE];
				if (!log) return;
				if (!first) first = log;

				let {
					input_tokens = 0,
					cached_tokens = 0,
					output_tokens = 0,
					reasoning_tokens = 0,
					cache_write_tokens = 0,
					cost = 0,
					duration = 0
				} = log;

				duration /= 1000;

				totalInput += input_tokens;
				totalCacheRead += cached_tokens;
				totalOutput += output_tokens;
				totalReasoning += reasoning_tokens;
				totalCacheWrite += cache_write_tokens;
				totalCost += cost / LLM_COST_SCALE;
				totalTime += duration;
			});

			if (!first) return;

			const tokenLines = [];
			if (totalInput) tokenLines.push(`<i class='ri-upload-fill'></i> ${formatKM(totalInput)}`);
			if (totalCacheRead) tokenLines.push(`<i class="ri-database-2-line"></i> ${formatKM(totalCacheRead)}`);
			if (totalOutput) tokenLines.push(`<i class='ri-download-fill'></i> ${formatKM(totalOutput)}`);
			if (totalReasoning) tokenLines.push(`<i class="ri-lightbulb-line"></i> ${formatKM(totalReasoning)}`);
			if (totalCacheWrite) tokenLines.push(`<i class="ri-save-line"></i> ${formatKM(totalCacheWrite)}`);
			const tokenLine = tokenLines.join(' ');

			logData.value = [
				tokenLine,
				totalTime,
				totalCost,
				first.currency,
				totalOutput / totalTime,
			];
		});

	})

	return $computed(() => {
		const item = unconscious(logData);
		if (typeof item !== 'object') return item;

		let [tokenLine,  duration, cost, currency, tps] = item;

		return <div className="ai-stats">
			<Icon_lightning style="color:var(--ap-green)" />
			<div className="row">
				<span style="color:var(--ap-blue)">{tps.toFixed(2)}TPS</span>
				<span style="color:var(--ap-green)">{formatDuration(duration)}{(duration - Math.trunc(duration)).toFixed(3).slice(1)}s</span>
				<span style="color:var(--ap-purple)" dangerouslySetInnerHTML={tokenLine}></span>
				{cost ? (<span
					style="color:var(--ap-yellow)">{currency === 'CNY' ? '¥' : '$'}{cost.toFixed(2)}</span>) : null}
			</div>
		</div>
	});
}
