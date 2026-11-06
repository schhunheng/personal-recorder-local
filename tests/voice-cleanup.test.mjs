import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCleanup } from '../public/audio/voice-cleanup.js';
function tone(cleanup, amplitude, hz, seconds = 1) {
  const input = new Float32Array(128), output = new Float32Array(128);
  let inputSquares = 0, outputSquares = 0, samples = 0;
  const blocks = Math.ceil(48000 * seconds / 128);
  for (let block = 0; block < blocks; block++) {
    for (let i = 0; i < 128; i++) input[i] = amplitude * Math.sin(2 * Math.PI * hz * (block * 128 + i) / 48000);
    cleanup.process(input, output);
    if (block >= Math.floor(blocks / 2)) {
      for (let i = 0; i < 128; i++) { inputSquares += input[i] ** 2; outputSquares += output[i] ** 2; samples++; }
    }
  }
  return { input: Math.sqrt(inputSquares / samples), output: Math.sqrt(outputSquares / samples) };
}
test('voice cleanup attenuates quiet noise, opens quickly for speech and closes after pauses', () => {
  const cleanup = new VoiceCleanup(48000); cleanup.configure(true, -45);
  const noise = tone(cleanup, 0.001, 1000);
  assert.ok(noise.output / noise.input < 0.05, 'quiet noise reduced by at least 26 dB');
  const speech = tone(cleanup, 0.1, 1000, 0.04);
  assert.ok(speech.output / speech.input > 0.9, 'expander opens within 40 ms');
  const tail = tone(cleanup, 0.001, 1000);
  assert.ok(tail.output / tail.input < 0.05, 'expander closes again after a pause');
});
test('rumble is attenuated without heavily filtering voice frequencies', () => {
  const cleanup = new VoiceCleanup(48000); cleanup.configure(true, -60);
  const rumble = tone(cleanup, 0.1, 20);
  const voice = tone(cleanup, 0.1, 1000);
  assert.ok(rumble.output / rumble.input < 0.4);
  assert.ok(voice.output / voice.input > 0.95);
});
test('cleanup bypass preserves samples and missing inputs do not leak old samples', () => {
  const cleanup = new VoiceCleanup(48000);
  const input = Float32Array.from([0.1, -0.3, 0, 0.5]), output = new Float32Array(4);
  cleanup.process(input, output); assert.deepEqual(output, input);
  cleanup.process(undefined, output); assert.ok(output.every(value => value === 0));
  cleanup.configure(true, -45);
  tone(cleanup, 0.1, 1000);
  tone(cleanup, 0, 1000);
  cleanup.process(undefined, output); assert.ok(output.every(value => Math.abs(value) < 1e-10));
});

test('cleanup configuration preserves mute and safety output remains finite and bounded', async () => {
  let Processor;
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = {}; } };
  globalThis.registerProcessor = (_name, processor) => { Processor = processor; };
  await import('../public/audio/safety-processor.js');
  const processor = new Processor();
  const input = new Float32Array(128).fill(0.5), output = new Float32Array(128);
  processor.port.onmessage({ data: { muted: true } });
  processor.port.onmessage({ data: { voiceCleanup: true, gateThresholdDb: -40 } });
  processor.process([[input]], [[output]]);
  assert.ok(output.every(value => value === 0), 'changing cleanup settings does not unmute');
  processor.port.onmessage({ data: { muted: false } });
  input.set([NaN, Infinity, -Infinity, 100, -100]);
  processor.process([[input]], [[output]]);
  assert.ok(output.every(value => Number.isFinite(value) && Math.abs(value) <= 0.991));
});
