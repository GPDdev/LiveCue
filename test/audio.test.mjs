import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { encodeWav, splitHint } from '../src/audio.mjs';

test('WAV 为16位单声道，采样率、文件长度和削波正确', () => {
  const buffer = encodeWav(Float32Array.from([-2, -1, 0, 1, 2]), 16000);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 54); assert.equal(view.getUint32(4, true), 46);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767]);
});
test('流式回答拆分要点、稿件和待确认，支持尚未完整生成的文本', () => {
  assert.deepEqual(splitHint('【回答要点】\n先说重点\n【口述稿】\n我的项目\n【需确认】\n结果待补充'), { points: '先说重点', draft: '我的项目', check: '结果待补充' });
  assert.deepEqual(splitHint('【回答要点】\n第一条'), { points: '第一条', draft: '', check: '' });
});
test('音频处理器忽略静音，混合双声道并按六秒输出', () => {
  let Processor;
  const messages = [];
  const context = { sampleRate: 16000, Float32Array, Math, AudioWorkletProcessor: class { port = { postMessage: value => messages.push(value.samples ? { ...value, samples: value.samples.slice() } : value) }; }, registerProcessor: (_name, value) => Processor = value };
  vm.runInNewContext(fs.readFileSync(new URL('../src/pcm-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor();
  for (let i = 0; i < 750; i++) processor.process([[new Float32Array(128)]]);
  assert.equal(messages.filter(item => item.samples).length, 0);
  for (let i = 0; i < 750; i++) processor.process([[new Float32Array(128).fill(.1), new Float32Array(128).fill(.3)]]);
  const audio = messages.filter(item => item.samples);
  assert.equal(audio.length, 1); assert.equal(audio[0].samples.length, 96000);
  assert.ok(Math.abs(audio[0].samples[0] - .2) < .00001);
});
