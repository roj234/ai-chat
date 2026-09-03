import {$state, unconscious} from "unconscious";
import {formatDate} from "unconscious/common/Utils.js";
import {messages} from "../states.js";
import {getBillingLog} from "../database.js";
import {LLM_COST_SCALE} from "/backend/sync.js";
import {prettyError} from "../utils/utils.js";

/**
 *
 * @param {AiChat.MessageListItem} m
 * @return {JSX.Element}
 * @constructor
 */
export const UsageBlock = (m) => {
	const logData = $state("加载中");

	return (<div className="stats" onMouseEnter.once={() => {
		Promise.all(messages.slice(m.index, m.end_index).map(m => m.log || getBillingLog(m.id))).then((logs) => {
			let totalInput = 0;
			let totalCacheRead = 0;
			let totalOutput = 0;
			let totalReasoning = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;
			let totalTime = 0;

			logs.forEach(item => {
				if (!item) return;

				let {
					input_tokens = 0,
					cached_tokens = 0,
					output_tokens = 0,
					reasoning_tokens = 0,
					cache_write_tokens = 0,
					cost = 0,
					duration = 0
				} = item;

				duration /= 1000;

				totalInput += input_tokens;
				totalCacheRead += cached_tokens;
				totalOutput += output_tokens;
				totalReasoning += reasoning_tokens;
				totalCacheWrite += cache_write_tokens;
				totalCost += cost / LLM_COST_SCALE;
				totalTime += duration;
			});

			const log = logs[0];
			if (!log) {
				logData.value = "无记录";
				return;
			}
			logData.value = [
				totalInput,
				totalCacheRead,
				totalOutput,
				totalReasoning,
				totalCacheWrite,
				log.time,
				log.latency / 1000,
				totalTime,
				totalCost,
				log.currency,
				totalOutput / totalTime,
				logs.findLast(Boolean)?.finish_reason
			];
		}, (err) => {
			logData.value = "错误：" + prettyError(err)
		});
	}}>
		<i className="ri-information-line"></i>
		<div className="stats-popover">
			{() => {
				const item = unconscious(logData);
				if (typeof item !== 'object') return <div className="stats-row">
					<div className="stats-row-top">{item || "数据暂缺"}</div>
				</div>;

				let [
					input_tokens, cached_tokens, output_tokens, reasoning_tokens, cache_write_tokens,
					time, latency, duration, cost, currency, tps, finish_reason
				] = item;

				return <div className="stats-row">
					<div className="stats-row-top">
						<span className="tps">{tps ? tps.toFixed(2) + " TPS" : finish_reason}</span>
						&nbsp;
						<span className="timestamp" title={`开始于: ${formatDate('Y-m-d H:i:s', time)}\n首字延迟: ${latency.toFixed(2)}s`}>
							{duration.toFixed(2)}s
						</span>
					</div>
					<div className="stats-row-bottom">
						{input_tokens ? <span>↑ <b>{input_tokens}{cached_tokens ? ` (+${cached_tokens})` : null}</b> Tok</span> : null}
						{output_tokens ? <span title={"缓存写入: " + cache_write_tokens}>↓ <b>{output_tokens}{reasoning_tokens ? ` (${reasoning_tokens} 思考)` : null}</b> Tok</span> : null}
						{cost ? (<span>价格: <b>{currency === 'CNY' ? '¥' : '$'}{cost.toFixed(6)}</b></span>) : null}
					</div>
				</div>;
			}}
		</div>
	</div>);
}