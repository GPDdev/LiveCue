export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, string) => [...string].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return buffer;
}

export function splitHint(text) {
  const draftIndex = text.indexOf('【口述稿】');
  const checkIndex = text.indexOf('【需确认】');
  return {
    points: text.slice(0, draftIndex < 0 ? (checkIndex < 0 ? text.length : checkIndex) : draftIndex).replace('【回答要点】', '').trim(),
    draft: draftIndex < 0 ? '' : text.slice(draftIndex + 5, checkIndex < 0 ? text.length : checkIndex).trim(),
    check: checkIndex < 0 ? '' : text.slice(checkIndex + 5).trim()
  };
}

export class AudioCapture {
  constructor(onChunk, onLevel) { this.onChunk = onChunk; this.onLevel = onLevel; this.nodes = []; this.closed = false; }
  async start(streams) {
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    if (this.closed) { await this.context.close(); return; }
    for (const { stream, source } of streams) {
      const input = this.context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(this.context, 'pcm-chunker');
      const silence = this.context.createGain();
      silence.gain.value = 0;
      worklet.port.onmessage = ({ data }) => {
        if (this.closed) return;
        this.onLevel(source, data.level);
        if (data.samples) this.onChunk(source, encodeWav(data.samples, this.context.sampleRate));
      };
      input.connect(worklet).connect(silence).connect(this.context.destination);
      this.nodes.push(input, worklet, silence);
    }
    await this.context.resume();
  }
  async stop() {
    this.closed = true;
    for (const node of this.nodes) { if (node.port) node.port.onmessage = null; node.disconnect(); }
    this.nodes = [];
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
