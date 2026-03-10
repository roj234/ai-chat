/**
 * LLM 出错/中断音效
 * 风格：沉闷、下降感、非侵略性提示
 */
export default () => {
	const ctx = new AudioContext();

	const playTone = (freq, startTime, duration) => {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		// 使用三角波 (Triangle)，比正弦波更厚重，比方波更柔和
		osc.type = 'triangle';

		osc.frequency.setValueAtTime(freq, startTime);
		// 频率快速下滑，模拟“掉落”或“失败”的感觉
		osc.frequency.exponentialRampToValueAtTime(freq * 0.8, startTime + duration);

		gain.gain.setValueAtTime(0, startTime);
		gain.gain.linearRampToValueAtTime(0.15, startTime + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

		// 增加一个低通滤波器，让声音听起来更“闷”，不刺耳
		const filter = ctx.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.setValueAtTime(1000, startTime);

		osc.connect(filter);
		filter.connect(gain);
		gain.connect(ctx.destination);

		osc.start(startTime);
		osc.stop(startTime + duration);
	};

	const now = ctx.currentTime;

	// 音符设计：使用低频且不和谐的音程（小二度或大七度关系）
	// 第一声：低沉的警告
	playTone(220.00, now, 0.2); // A3
	// 第二声：更低，产生一种“断掉”的效果
	playTone(207.65, now + 0.12, 0.3); // Ab3 (产生不和谐感)
};