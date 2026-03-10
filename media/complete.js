/**
 * LLM 生成结束音效合成器
 * 风格：现代、轻量、科技感
 */
export default () => {
	const ctx = new AudioContext();

	const playTone = (freq, startTime, duration) => {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();

		// 使用正弦波保证声音清脆
		osc.type = 'sine';
		osc.frequency.setValueAtTime(freq, startTime);

		// 指数级频率微升，增加灵动感 (2026年流行的UI音效设计手法)
		osc.frequency.exponentialRampToValueAtTime(freq * 1.05, startTime + duration);

		// 增益控制（ADSR包络）
		gain.gain.setValueAtTime(0, startTime);
		gain.gain.linearRampToValueAtTime(0.2, startTime + 0.01); // 快速攻击
		gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration); // 指数衰减

		osc.connect(gain);
		gain.connect(ctx.destination);

		osc.start(startTime);
		osc.stop(startTime + duration);
	};

	const now = ctx.currentTime;

	// 音符设计：使用 E6 和 A6 (纯四度)，营造一种轻快、解决的完成感
	// 第一声：基础音
	playTone(1318.51, now, 0.15); // E6
	// 第二声：稍高，带出完成感
	playTone(1760.00, now + 0.08, 0.25); // A6
};