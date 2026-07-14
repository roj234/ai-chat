import {webviewRequestAudio} from "../../vendor/jsBridge.js";

const lameUrl = import.meta.env.DEV ? new URL('/assets/lame.min.mjs', import.meta.url).href : './lame.min.mjs';
const workletUrl = import.meta.env.DEV ? new URL('/assets/pcm-worklet.js', import.meta.url).href : new URL(/* @vite-ignore */'./pcm-worklet.js', import.meta.url).href;

export class Mp3Recorder {
	#ctx;
	#stream;
	#worklet;
	#encoder;

	#chunks  = [];
	_recording  = false;
	#totalEncMs = 0;
	#totalBytes = 0;

	// 可视化
	#analyser;
	#analyserBuf;
	#animId;

	// 停止控制
	#onFlushed;

	constructor(options = {}) {
		this.bitRate    = options.bitRate    ?? 64;
		this.sampleRate = options.sampleRate ?? 48000;
		this.channels   = options.channels   ?? 1;

		// 回调
		this.onStats      = options.onStats      ?? null;
		this.onVisualData = options.onVisualData ?? null;
	}

	async init() {
		if (IS_ANDROID_BUILD && !await webviewRequestAudio())
			throw new Error('录音权限被拒绝, 请去设置打开');

		this.#stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: { ideal: this.channels },
				sampleRate:   { ideal: this.sampleRate },
				echoCancellation: true,
				noiseSuppression: true,
			}
		});
		this.#ctx = new AudioContext({ sampleRate: this.sampleRate });
	}

	async start() {
		if (!this.#stream) await this.init();

		this.#chunks  = [];
		this.#totalEncMs = 0;
		this.#totalBytes = 0;

		const lame = await import(/* @vite-ignore */lameUrl);
		this.#encoder = new lame.Mp3Encoder(this.channels, this.sampleRate, this.bitRate);

		// 加载 AudioWorklet
		await this.#ctx.audioWorklet.addModule(workletUrl);
		this.#worklet = new AudioWorkletNode(this.#ctx, 'f32to16', {
			numberOfInputs: 1,
			numberOfOutputs: 0,
		});

		this.#worklet.port.postMessage({
			type: 'init',
			channels: this.channels,
			frameSize: 1152,
		});

		this.#worklet.port.onmessage = (e) => {
			if (e.data.type === 'pcm')    this.#onPcmFrame(e.data);
			if (e.data.type === 'flushed') this.#onFlushed?.();
		};

		// 音频图
		const source = this.#ctx.createMediaStreamSource(this.#stream);
		source.connect(this.#worklet);

		// 可视化
		if (this.onVisualData) {
			this.#analyser = new AnalyserNode(this.#ctx, {
				smoothingTimeConstant: 0.4,
				fftSize: 256
			});
			this.#analyserBuf = new Uint8Array(this.#analyser.frequencyBinCount);
			source.connect(this.#analyser);
		}

		this._recording = true;
	}

	async stop() {
		this._recording = false;

		// 通知 worklet 刷新残余
		const flushed = new Promise(r => { this.#onFlushed = r; });
		this.#worklet.port.postMessage({ type: 'flush' });

		const timeout = new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Worklet flush timeout')), 2000)
		);
		await Promise.race([flushed, timeout]);

		// 收尾编码
		const t0 = performance.now();
		const final = this.#encoder.flush();
		if (final.length > 0) {
			this.#chunks.push(final);
			this.#totalBytes += final.length;
		}
		this.#totalEncMs += performance.now() - t0;

		this.#cleanup();
		return new Blob(this.#chunks, { type: 'audio/mpeg' });
	}

	destroy() {
		this.#cleanup();
		if (this.#ctx) { this.#ctx.close(); this.#ctx = null; }
	}

	#onPcmFrame({ channels: chData }) {
		const t0 = performance.now();
		const mp3 = this.#encoder.encodeBuffer(...chData);
		const elapsed = performance.now() - t0;

		if (mp3.length) {
			this.#chunks.push(mp3);
			this.#totalBytes += mp3.length;
		}

		this.#totalEncMs += elapsed;

		if (this.onVisualData) {
			this.#analyser.getByteFrequencyData(this.#analyserBuf);
			this.onVisualData(this.#analyserBuf);
		}

		this.onStats?.([ this.#totalBytes, this.#totalEncMs ]);
	}

	#cleanup() {
		if (this.#worklet) { this.#worklet.disconnect(); this.#worklet = null; }
		if (this.#stream)  { this.#stream.getTracks().forEach(t => t.stop()); this.#stream = null; }
		this.#encoder = null;
	}
}
