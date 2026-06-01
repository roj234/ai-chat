import {showToast} from "./components/Toast.js";
import {config} from "./states.js";
import {$state, debugSymbol, isReactive} from "unconscious";

const RAW_MESSAGE = debugSymbol("RAW_MESSAGE");
const LOOKBEHIND = 512;

/**
 *
 * @param {number} topP
 * @param {number} minP
 * @param {Record<string, number>} patterns 阻止生成的模式
 * @param {{retry: Function}} context 用于重新调用API的上下文函数
 * @param {number} [window=100] 保留最近window个token用于回退
 * @return {AiChat.AntiSlop}
 */
export const createAntiSlopSampler = (topP, minP, patterns, context, window = 100) => {
	const constant_pattern_tmp = [];
	const prob_patterns = Object.entries(patterns).filter(([pattern, prob]) => {
		if (prob !== 1) return true;
		constant_pattern_tmp.push(pattern);
	}).map(([str, prob]) => ({
		regex: new RegExp(str, "g"),
		threshold: prob,
	}));
	const constant_pattern = new RegExp("(?:"+constant_pattern_tmp.join(")|(?:")+")", "g");

	const prob_pattern_indices = Array(prob_patterns.length).fill(0);
	let constant_pattern_index = 0;

	let retry_count = 0;

	const toastMessage = $state();
	let toast;
	let toastTime;
	let toastTimer;
	const displayToast = (message) => {
		const now = Date.now();
		if (message) {
			toastTime = now;
			toastMessage.value = message;
			if (!toast) {
				toast = showToast(toastMessage, 'error', 0);
			}
		}
		if (!toastTimer) {
			const prevToastTime = toastTime;
			toastTimer = setTimeout(() => {
				toastTimer = null;
				if (toastTime !== prevToastTime) return displayToast();
				if (toast) {
					toast();
					toast = null;
				}
			}, 2000);
		}
	}

	/**
	 * @type {{
	 *     token: string,
	 *     start: number,
	 *     end: number,
	 *     candidates: {
	 *         token: string,
	 *         prob: number
	 *     }[]
	 * }[]}
	 */
	const history = [];

	/**
	 * @param {OpenAI.TextChoice | OpenAI.ChatChoice} chunk
	 * @param {AiChat.AssistantMessage} message
	 * @return true | undefined
	 */
	const sample = (chunk, message) => {
		const logprobs_list = chunk.logprobs?.content;
		if (!logprobs_list) return;

		// 到底应该接受logprobs还是content？我的分支貌似已经修了这问题
		if (!chunk.delta?.content && !chunk.delta?.reasoning_content) return;

		/** @type {string} */
		let content = message[RAW_MESSAGE] ?? ((message.think?.content || "") + message.content);
		const isThinking = isReactive(message.think);

		for (const logprobs of logprobs_list) {
			const start = content.length;
			const token = logprobs.token;
			content += token;
			const end = content.length;

			let topLogProbs = logprobs.top_logprobs;
			let filteredCandidates = [];
			if (topLogProbs) {
				let candidates = topLogProbs.map(c => ({
					token: c.token,
					prob: Math.exp(c.logprob) // 将 logprob 转为线性概率
				}));

				// Min-P
				if (candidates.length > 0) {
					const maxProb = candidates[0].prob;
					candidates = candidates.filter(c => c.prob >= maxProb * minP);
				}

				// Top-P
				let cumSum = 0;
				for (const c of candidates) {
					filteredCandidates.push(c);
					cumSum += c.prob;
					if (cumSum >= topP) break; // 达到阈值，跳出循环
				}
			} else {
				filteredCandidates = logprobs.top_probs;
			}

			history.splice(0, history.length - window);
			history.push({
				token,
				start,
				end,
				// 删除已经选中的这项
				candidates: filteredCandidates.filter(c => c.token !== token)
			});

			constant_pattern.lastIndex = Math.max(constant_pattern_index, content.length - LOOKBEHIND); // 重置正则状态
			let match = constant_pattern.exec(content);
			if (!match) {
				const other_pattern = prob_patterns;
				for (let i = 0; i < other_pattern.length; i++){
					const {regex, threshold} = other_pattern[i];
					regex.lastIndex = Math.max(prob_pattern_indices[i], content.length - LOOKBEHIND);

					match = regex.exec(content);
					if (match) {
						prob_pattern_indices[i] = match.index+1;
						if (Math.random() > threshold) {
							displayToast(`违反约束: "${match[0]}" 位置 ${match.index}\n概率跳过`);
							match = null;
						}
						else break;
					}
				}
			}

			if (match) {
				const matchStartIdx = match.index;

				let targetIdx = history.findIndex(item => item.start <= matchStartIdx && item.end > matchStartIdx);
				history.length = targetIdx + 1;

				while (history.length) {
					const last = history.at(-1);
					const { start, token, candidates } = last;

					while (candidates.length) {
						const nextBest = candidates.shift();

						last.token = nextBest.token;
						last.end = last.start + nextBest.token.length;
						let newPrefix = content.slice(0, start) + nextBest.token;

						constant_pattern.lastIndex = matchStartIdx - match[0].length;
						if (constant_pattern.exec(newPrefix)) continue;

						++retry_count;
						displayToast(`违反约束(第${retry_count}次重试): "${match[0]}" 位置 ${start}\n重选: "${token}" -> "${nextBest.token}" (概率: ${(nextBest.prob*100).toFixed(2)}%)`);

						constant_pattern_index = start;
						prob_pattern_indices.fill(start);

						// prefill
						message[RAW_MESSAGE] = newPrefix;
						if (message.think) {
							const format = message.think.format;
							if (format.startsWith("m")) {
								newPrefix = newPrefix.slice(format.length+1);
							}

							if (isThinking) {
								message.think.content = newPrefix;
							} else {
								let tend = message.think.content.length;
								if (start < tend) {
									message.think.content = newPrefix;
									message.content = '';
								} else {
									message.think.content = newPrefix.slice(0, tend);
									message.content = newPrefix.slice(tend);
								}
							}
						} else {
							message.content = newPrefix;
						}

						config.canPrefill = true;
						context.retry();
						return true;
					}
					history.pop();
				}

				throw "错误：回退至滑动窗口起点仍无法避开非法模式。";
			}
		}

		displayToast();
		message[RAW_MESSAGE] = content;
	};

	return {sample};
}

