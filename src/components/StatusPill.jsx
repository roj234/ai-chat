import {config} from "../states.js";
import "./StatusPill.css";
import {$computed, unconscious} from "unconscious";

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
		this.textContent = phrases[this.#index++];
		if (phrases.length > 1 && config.afkState < 2) {
			this.#timer = setInterval(() => {
				this.#index = (this.#index + 1) % phrases.length;
				this.#render();
			}, 4000);
		}
	}

	disconnectedCallback() {
		clearInterval(this.#timer);
	}

	/*setAttribute(qualifiedName, value) {
		if (qualifiedName === "text") {
			this.#phrases = [value];
		}
	}*/

	#render() {
		// 使用 requestAnimationFrame 或简单的 transition 配合滤镜
		const style = this.style;

		style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
		style.opacity = '0';
		style.filter = 'blur(10px)'; // 文字散开效果
		style.letterSpacing = "5px";

		setTimeout(() => {
			this.textContent = phrases[this.#index];
			style.opacity = '';
			style.filter = '';
			style.letterSpacing = '';
		}, 400); // 稍微长一点的停顿会让切换更有质感
	}
}

// 注册自定义元素
customElements.define('loading-motd', LoadingMOTD);

export const StatusPill = ({kind, data}) => {
	const start = Date.now();
	return $computed(() => {
		switch (unconscious(kind)) {
			default:
			case "connect":
				return <div className="ai-progress connect">
					<div className="icon"></div>
					<loading-motd />
				</div>;
			case "prefill":
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

			case "wait":
				return <div className="ai-progress wait">
					<div className="icon"></div>
					<span>正在准备响应...</span>
				</div>;

			case "generate":
				return <div className="ai-progress generate">
					<svg className="icon" viewBox="0 0 24 24" fill="currentColor">
						<path d="M13 2L3 14h7v8l10-12h-7z"/>
					</svg>
					{unconscious(data).tps ? <>
						<span className="num">{() => data.tps?.toFixed(2)}</span>tps ·
						<span className="num">{() => data.tokens}</span>tokens ·
					</> : <>
						<span className="num">{() => (data.len / ((Date.now() - start) / 1000)).toFixed(2)}</span>cps ·
						<span className="num">{() => data.len}</span>chars ·
					</>}
					<span className="num">{$computed(() => ((Date.now() - start) / 1000).toFixed(2), [data])}</span>s
				</div>
		}
	}, [kind]);
};