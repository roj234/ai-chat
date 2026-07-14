/* ═══════════════════════════════════════════════
   pcm-worklet.js — AudioWorklet 处理器
   累积 PCM → Int16 → 零拷贝 transfer 到主线程
   ═══════════════════════════════════════════════ */

class PcmCompressor extends AudioWorkletProcessor {
  #buffers;
  #offset;
  #frameSize;
  #active;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      switch (e.data.type) {
        case 'init':
          const channels  = e.data.channels || 1;
          this.#frameSize = e.data.frameSize || 1152;
          this.#buffers   = Array(channels);
          for (let ch = 0; ch < channels; ch++) {
            this.#buffers[ch] = new Float32Array(this.#frameSize);
          }
          this.#offset = 0;
          break;

        case 'flush':
          this.#flush();
          this.port.postMessage({ type: 'flushed' });
          this.#buffers = null;
          break;
      }
    };
  }

  process(inputs) {
    if (!this.#buffers) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const blockLen = input[0].length;  // 通常是 128
    let read = 0;

    while (read < blockLen) {
      const room = this.#frameSize - this.#offset;
      const copy = Math.min(blockLen - read, room);

      for (let ch = 0; ch < this.#buffers.length; ch++) {
        // 如果实际通道数不够则 fallback 到 ch0
        const src = input[Math.min(ch, input.length - 1)];
        this.#buffers[ch].set(
          src.subarray(read, read + copy),
          this.#offset
        );
      }

      this.#offset += copy;
      read += copy;

      if (this.#offset >= this.#frameSize) {
        this.#flush();
      }
    }

    return true;
  }

  /* ─── 输出一帧：Float32 → Int16 → transfer ─── */
  #flush() {
    const len = this.#offset;
    if (!len) return;

    const channels = this.#buffers.length;

    const chData  = Array(channels);
    const transfers = [];

    for (let ch = 0; ch < channels; ch++) {
      const src   = this.#buffers[ch];
      const int16 = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = src[i];
        int16[i] = (s > 1.0 ? 32767 : s < -1.0 ? -32768 : s * 32767) | 0;
      }
      chData[ch] = int16;
      transfers.push(int16.buffer);
    }

    this.port.postMessage(
      { type: 'pcm', channels: chData, length: len },
      transfers
    );

    this.#offset = 0;
  }
}

registerProcessor('f32to16', PcmCompressor);
