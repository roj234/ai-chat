class ToneRenderer {
	constructor(json) {
		this.data = json;
		this.ctx = new (window.AudioContext || window.webkitAudioContext)();
	}

	/**
	 * 播放单个音符
	 * @param {Object} note - {freq, time, duration, velocity}
	 */
	playNote(note) {
		const { config } = this.data;
		const { adsr, filter } = config;
		const startTime = this.ctx.currentTime + note.time;
		const stopTime = startTime + note.duration;

		// 1. 创建节点
		const osc = this.ctx.createOscillator();
		const gain = this.ctx.createGain();
		const lowpass = this.ctx.createBiquadFilter();

		// 2. 配置振荡器与频率滑移 (Pitch Ramp)
		osc.type = config.oscType;
		osc.frequency.setValueAtTime(note.freq, startTime);
		// 2026年流行的微妙滑音效果
		osc.frequency.exponentialRampToValueAtTime(
			note.freq * config.pitchMod,
			stopTime
		);

		// 3. 配置滤波器
		lowpass.type = filter.type;
		lowpass.frequency.setValueAtTime(filter.frequency, startTime);
		lowpass.Q.setValueAtTime(filter.q, startTime);

		// 4. 配置 ADSR 包络 (核心改进)
		const peakGain = note.velocity || 1.0;
		gain.gain.setValueAtTime(0, startTime);
		// Attack: 快速升至峰值
		gain.gain.linearRampToValueAtTime(peakGain, startTime + adsr.attack);
		// Decay: 降至维持电平
		gain.gain.exponentialRampToValueAtTime(
			peakGain * adsr.sustain + 0.001,
			startTime + adsr.attack + adsr.decay
		);
		// Release: 结束前开始释放
		gain.gain.exponentialRampToValueAtTime(0.001, stopTime + adsr.release);

		// 5. 连接链路: OSC -> Filter -> Gain -> Destination
		osc.connect(lowpass);
		lowpass.connect(gain);
		gain.connect(this.ctx.destination);

		// 6. 启动与停止
		osc.start(startTime);
		osc.stop(stopTime + adsr.release);
	}

	playAll() {
		if (this.ctx.state === 'suspended') this.ctx.resume();
		this.data.sequence.forEach(note => this.playNote(note));
	}
}