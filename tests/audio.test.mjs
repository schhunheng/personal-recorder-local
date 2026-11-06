import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameAdapter } from '../public/audio/frame-adapter.js';

test('480-sample framing is sample-exact across 128-sample worklet quanta', () => {
  let frames = 0;
  const adapter = new FrameAdapter(frame => { frames++; for (let i = 0; i < frame.length; i++) frame[i] *= 0.5; });
  const length = 48000 * 10;
  const input = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.07));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 128) adapter.process(input.subarray(i, i + 128), output.subarray(i, i + 128));
  assert.equal(frames, length / 480);
  for (let i = 0; i < length; i++) assert.equal(output[i], i < 480 ? 0 : input[i - 480] * 0.5);
});
test('handles missing input and nonstandard quantum sizes without stale samples', () => {
  const adapter = new FrameAdapter(() => {});
  const result = new Float32Array(999);
  adapter.process(undefined, result);
  assert.ok(result.every(value => value === 0));
});
test('three simulated hours maintain exact frame counts and fixed buffer capacity', () => {
  const adapter = new FrameAdapter(() => {});
  const frame = adapter.frame, outputStorage = adapter.output;
  const input = new Float32Array(48000), output = new Float32Array(48000);
  input.fill(0.25);
  for (let second = 0; second < 3 * 3600; second++) adapter.process(input, output);
  assert.equal(adapter.frame, frame); assert.equal(adapter.output, outputStorage);
  assert.equal(adapter.position, 0);
  assert.ok(output.every(value => value === 0.25));
});
