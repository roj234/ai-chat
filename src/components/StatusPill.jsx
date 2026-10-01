import {config} from "../states.js";
import "./StatusPill.css";
import {$computed, unconscious} from "unconscious";
import {SP_CONNECT, SP_GENERATE, SP_PREFILL, SP_WAIT} from "./StatusPill_state.js";

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
		if (phrases.length > 1 && config.afkState < 2) {
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
			return <span className="c" style={"--delay:"+i}>{ch}</span>;
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
				return <div className="ai-progress connect">
					<div className="icon"></div>
					<loading-motd />
				</div>;
			case SP_WAIT:
				return <div className="ai-progress wait">
					<div className="icon"></div>
					<span>正在准备响应...</span>
				</div>;
			case SP_PREFILL:
				return <div className="ai-progress prefill">
					<svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
						<path d="M21 12a9 9 0 1 1-6.219-8.56"/>
					</svg>
					<span>预填充</span>
					<div className="track">
						<div className="fill" style:width={() => unconscious(data) * 100 + "%"}></div>
					</div>
					<span className="num">{() => (unconscious(data) * 100).toFixed(1)+"%"}</span>
				</div>;
			case SP_GENERATE:
				return <div className="ai-progress generate">
					<svg className="icon" viewBox="0 0 24 24" fill="currentColor">
						<path d="M13 2L3 14h7v8l10-12h-7z"/>
					</svg>
					{unconscious(data).tps != null ? <>
						<span className="num">{() => data.tps?.toFixed(2)}</span>tps ·
						<span className="num">{() => data.tokens}</span>tokens ·
					</> : <>
						<span className="num">{() => (data.len / ((Date.now() - (data.start||start)) / 1000)).toFixed(2)}</span>cps ·
						<span className="num">{() => data.len}</span>chars ·
					</>}
					<span className="num">{$computed(() => ((Date.now() - (data.start||start)) / 1000).toFixed(2), [data])}</span>s
				</div>
		}
	}, [kind]);
};