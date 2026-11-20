class PCMChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(sampleRate * 6);
    this.offset = 0; this.energy = 0; this.voiced = 0; this.frames = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.buffer[this.offset++] = value;
      this.energy += value * value;
      if (Math.abs(value) > 0.012) this.voiced++;
      if (this.offset === this.buffer.length) {
        // shortcut: 六秒 PCM 分块加静音门限；需要词级低延迟时升级流式 ASR。
        if (this.voiced > sampleRate * 0.06) this.port.postMessage({ samples: this.buffer, level: Math.sqrt(this.energy / this.offset) });
        this.offset = 0; this.energy = 0; this.voiced = 0;
      }
    }
    if (++this.frames % 24 === 0) this.port.postMessage({ level: this.offset ? Math.sqrt(this.energy / this.offset) : 0 });
    return true;
  }
}
registerProcessor('pcm-chunker', PCMChunker);
