import {showToast} from "./components/Toast.js";
import {sendUserChatMessage} from "./api-request.js";
import {config} from "./states.js";
import {debugSymbol, isReactive} from "unconscious";

const RAW_MESSAGE = debugSymbol("RAW_MESSAGE");
const LOOKBEHIND = 512;

export class AntiSlop {
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
	history = [];

	/**
	 *
	 * @param {number} topP
	 * @param {number} minP
	 * @param {Record<string, number>} patterns slop的模式
	 */
	constructor(topP, minP, patterns) {
		this.topP = topP;
		this.minP = minP;

		const constant_patterns = [];
		this.prob_patterns = Object.entries(patterns).filter(([pattern, prob]) => {
			if (prob === 1) {
				constant_patterns.push(pattern);
			} else {
				return true;
			}
		}).map(([str, prob]) => ({
			regex: new RegExp(str, "g"),
			threshold: prob,
		}));
		this.last_match = Array(this.prob_patterns.length).fill(0);
		this.pattern = new RegExp("(?:"+constant_patterns.join(")|(?:")+")", "g");
		this.main_match = 0;
		this.retry_count = 0;
		this.window = 100; // 保留最近的100个节点
	}

	/**
	 * @param {OpenAI.TextChoice | OpenAI.ChatChoice} chunk
	 * @param {AiChat.AssistantMessage} message
	 * @return true | undefined
	 */
	sample(chunk, message) {
		const logprobs_list = chunk.logprobs?.content;
		if (!logprobs_list) return;

		// 到底应该接受logprobs还是content？我的分支貌似已经修了这问题
		if (!chunk.delta?.content && !chunk.delta?.reasoning_content) return;

		/** @type {string} */
		let content = message[RAW_MESSAGE] || "";
		const isThinking = isReactive(message.think);
		const history = this.history;

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
					candidates = candidates.filter(c => c.prob >= maxProb * this.minP);
				}

				// Top-P
				let cumSum = 0;
				for (const c of candidates) {
					filteredCandidates.push(c);
					cumSum += c.prob;
					if (cumSum >= this.topP) break; // 达到阈值，跳出循环
				}
			} else {
				filteredCandidates = logprobs.top_probs;
				//console.log(filteredCandidates);
			}

			history.splice(0, history.length - this.window);
			history.push({
				token,
				start,
				end,
				// 删除已经选中的这项
				candidates: filteredCandidates.filter(c => c.token !== token)
			});

			this.pattern.lastIndex = Math.max(this.main_match - LOOKBEHIND, 0); // 重置正则状态
			let match = this.pattern.exec(content);
			if (!match) {
				const other_pattern = this.prob_patterns;
				for (let i = 0; i < other_pattern.length; i++){
					const {regex, threshold} = other_pattern[i];
					regex.lastIndex = Math.max(this.last_match[i] - LOOKBEHIND, 0);

					match = regex.exec(content);
					if (match) {
						this.last_match[i] = match.index+1;
						if (Math.random() > threshold) {
							showToast(`违反约束: "${match[0]}" 位置 ${match.index}\n概率跳过`);
							match = null;
						}
						else break;
					}
				}
			}

			if (match) {
				const matchStartIdx = match.index;

				this.main_match = matchStartIdx;
				this.last_match.fill(matchStartIdx);

				let targetIdx = history.findIndex(item => item.start <= matchStartIdx && item.end > matchStartIdx);
				history.length = targetIdx + 1;
				//console.log(match, history);

				while (history.length) {
					const last = history.at(-1);
					const { start, token, candidates } = last;

					while (candidates.length) {
						const nextBest = candidates.shift();

						last.token = nextBest.token;
						last.end = last.start + nextBest.token.length;
						const newPrefix = content.substring(0, start) + nextBest.token;

						this.pattern.lastIndex = matchStartIdx - match[0].length;
						if (this.pattern.exec(newPrefix)) continue;

						++this.retry_count;
						showToast(`违反约束(第${this.retry_count}次重试): "${match[0]}" 位置 ${start}\n重选: "${token}" -> "${nextBest.token}" (概率: ${(nextBest.prob*100).toFixed(2)}%)`, "error");

						// prefill
						message[RAW_MESSAGE] = newPrefix;
						if (message.think) {
							if (isThinking) {
								message.think.content = newPrefix;
							} else {
								let tend = message.think.content.length;
								if (start < tend) {
									debugger;
									message.think.content = newPrefix;
									message.content = '';
								} else {
									message.think.content = newPrefix.substring(0, tend);
									message.content = newPrefix.substring(tend);
								}
							}
						} else {
							message.content = newPrefix;
						}

						requestIdleCallback(() => {
							// 小机灵鬼把它又给关闭了？
							config.allowContinue = true;
							sendUserChatMessage(null, this);
						});
						return true;
					}
					history.pop();
				}

				throw "错误：回退至滑动窗口起点仍无法避开非法模式。";
			}
		}

		message[RAW_MESSAGE] = content;
	}
}

