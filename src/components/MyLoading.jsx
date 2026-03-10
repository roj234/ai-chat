class MyLoading extends HTMLElement {
	constructor() {
		super();

		this.phrases = [
			"正在连接服务器",
			"正在解开张量的封印",
			"正在给显存超频",
			"正在调动一千亿个神经元",
			"正在尝试理解人类",
			"正在对齐颗粒度",
			"好东西就要来了",
		];
		this.index = 0;
		this.timer = null;
		this.interval = parseInt(this.getAttribute('interval')) || 4000;
	}

	connectedCallback() {
		this.render();
		if (this.phrases.length > 1)
			this.timer = setInterval(() => {
				this.index = (this.index + 1) % this.phrases.length;
				this.render();
			}, this.interval);
	}

	disconnectedCallback() {
		if (this.timer) clearInterval(this.timer);
	}

	setAttribute(qualifiedName, value) {
		if (qualifiedName === "text") {
			this.phrases = [value];
		}
	}

	render() {
		// 使用 requestAnimationFrame 或简单的 transition 配合滤镜
		this.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
		this.style.opacity = '0';
		this.style.filter = 'blur(10px)'; // 文字散开效果
		this.style.letterSpacing = "5px";

		setTimeout(() => {
			this.textContent = this.phrases[this.index];
			this.style.opacity = '';
			this.style.filter = '';
			this.style.letterSpacing = '';
		}, 400); // 稍微长一点的停顿会让切换更有质感
	}
}

// 注册自定义元素
customElements.define('my-loading', MyLoading);