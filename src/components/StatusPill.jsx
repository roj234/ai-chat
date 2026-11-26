import {abortCompletion, config, PP_UNATTENDED} from "../states.js";
import "./StatusPill.css";
import {$cleanup, $computed, unconscious} from "unconscious";
import {SP_CONNECT, SP_GENERATE, SP_PREFILL, SP_RETRY, SP_WAIT} from "./StatusPill_state.js";
import {Icon_lightning} from "./Icons.jsx";

const phrases = [
	"正在连接服务器",
	"内容由AI生成，可能包含错误，请仔细甄别",
	"为随机鹦鹉的梦境转码",
	"你是一只猫娘",
	"正在解开张量的封印",
	"正在给显存超频",
	"正在调动一千亿个神经元",
	"正在尝试理解人类",
	"正在对齐颗粒度",
	"好东西就要来了",
];

class LoadingMOTD extends HTMLElement {
	#index = 0;
	#timer;

	connectedCallback() {
		this.#render(phrases[this.#index++ % phrases.length]);
		if (phrases.length > 1 && config.pausePolicy !== PP_UNATTENDED) {
			this.#timer = setInterval(() => {
				this.#render(phrases[this.#index++ % phrases.length]);
			}, 6000);
		}
	}

	disconnectedCallback() {
		clearInterval(this.#timer);
	}

	/**
	 * 每个字符渲染为独立的 span，索引写入 CSS 变量 --i：
	 * 弹跳登场的延迟与波浪浮动的相位均按 --i 错开，动画全部由 CSS 驱动。
	 * @param {string} text 目标文本
	 */
	#render(text) {
		this.replaceChildren(...Array.from(text, (ch, i) => {
			return <span className="c" style={"--delay:" + i}>{ch}</span>;
		}));
	}
}

// 注册自定义元素
customElements.define('loading-motd', LoadingMOTD);

export const StatusPill = ({kind, data}) => {
	const start = Date.now();
	return $computed(() => {
		switch (unconscious(kind)) {
			default:
			case SP_CONNECT:
				return <div className="ai-status connect">
					<div className="icon" />
					<loading-motd />
				</div>;
			case SP_WAIT:
				return <div className="ai-status wait">
					<div className="icon" />
					<span>正在准备响应...</span>
				</div>;
			case SP_RETRY: {
				const [count, maxCount, delay] = unconscious(data);
				const scheduledTime = Date.now() + delay;

				const SIZE = 24;
				const RADIUS = 8;
				const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

				const bar = <svg:circle className="-bar" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>;

				bar.style.strokeDasharray = bar.style.strokeDashoffset = CIRCUMFERENCE;
				//bar.style.stroke = 'var(--ap-yellow)';

				const anim = bar.animate([
					{ strokeDashoffset: 0 },
					{ strokeDashoffset: CIRCUMFERENCE }
				], delay);

				const node = <span/>;
				const callback = () => {
					const remain = Math.ceil((scheduledTime - Date.now()) / 1000);
					if (!remain) clearInterval(timer);

					node.textContent = remain;
					node.animate(
						[
							{transform: 'translateY(58%) scale(.7)', opacity: 0},
							{transform: 'translateY(0) scale(1)', opacity: 1}
						],
						{duration: 340, easing: 'cubic-bezier(.2,1.4,.4,1)'}
					);
				};

				callback();

				const timer = setInterval(callback, 1000);
				$cleanup(bar, () => clearInterval(timer));

				return <div className="ai-status wait" style="gap:4px">
					<div className="ring-progress" style={`width:${RADIUS * 2 + 2}px;height:${RADIUS * 2 + 2}px`}>
						<div className="icon" />
						<svg width={SIZE} height={SIZE}>
							<circle className="-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>
							{bar}
						</svg>
					</div>
					<span>发生错误，{node}s后重试... ({count} / {maxCount})</span>
					<button className="btn danger-focus ri-close-line" style="padding:4px" title="取消重试" onClick={() => abortCompletion.abort?.()} />
				</div>;
			}
			case SP_PREFILL:
				return <div className="ai-status prefill">
					<svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
						 stroke-linecap="round">
						<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
					</svg>
					<span>预填充</span>
					<div className="track">
						<div className="fill" style:width={() => unconscious(data) * 100 + "%"}></div>
					</div>
					<span className="num">{() => (unconscious(data) * 100).toFixed(1)+"%"}</span>
				</div>;
			case SP_GENERATE:
				return <div className="ai-status generate">
					<Icon_lightning />
					{unconscious(data).tps != null ? <>
						<span className="num">{() => data.tps?.toFixed(2)}</span>TPS ·
						<span className="num">{() => data.tokens}</span>tokens ·
					</> : <>
						<span className="num">{() => (data.len / ((Date.now() - (data.start||start)) / 1000) / 2.5).toFixed(2)}</span><span title="估计值">TPS<sup>*</sup></span> ·
						<span className="num">{() => data.len}</span>chars ·
					</>}
					<span className="num">{$computed(() => ((Date.now() - (data.start||start)) / 1000).toFixed(2), [data])}</span>s
				</div>
		}
	}, [kind]);
};