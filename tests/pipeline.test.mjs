import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let id = 0;
class Track {
  constructor(settings = {}) { this.id = String(++id); this.enabled = true; this.readyState = 'live'; this.settings = settings; }
  getSettings() { return this.settings; }
  stop() { this.readyState = 'ended'; }
}
class Node {
  constructor() { this.gain = { value: 1, setTargetAtTime() {} }; this.connections = []; }
  connect(other) { this.connections.push(other); return other; }
  disconnect(other) { this.connections = other ? this.connections.filter(node => node !== other) : []; }
}
class Context {
  constructor(options) { this.sampleRate = options.sampleRate; this.baseLatency = 0.01; this.currentTime = 0; this.state = 'running'; this.destination = new Node(); this.audioWorklet = { addModule: async () => {} }; }
  createGain() { return new Node(); }
  createAnalyser() { return new Node(); }
  createMediaStreamDestination() { const node = new Node(); const track = new Track(); node.stream = { getTracks: () => [track], getAudioTracks: () => [track] }; return node; }
  createMediaStreamSource(stream) { const node = new Node(); node.stream = stream; return node; }
  createDynamicsCompressor() { const node = new Node(); for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[key] = { value: 0 }; return node; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class Worklet extends Node {
  constructor(context, name) {
    super(); this.port = { postMessage() {}, close() {} };
    if (name === 'offline-rnnoise') setTimeout(() => this.port.onmessage?.({ data: { type: 'ready' } }), 0);
  }
}
test('pipeline routes processed output, swaps devices transactionally, falls back and recovers without replacing recording track', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  const calls = [];
  const captures = [];
  const media = new EventTarget();
  let rejectCapture = false;
  let aiAssets = false;
  media.getUserMedia = async ({ audio }) => {
    calls.push(audio);
    if (rejectCapture) throw Error('Device unavailable');
    const track = new Track({ sampleRate: 44100, noiseSuppression: audio.noiseSuppression });
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }; captures.push(stream); return stream;
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: media } });
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Worklet;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ rnnoise: aiAssets }) });
  const settings = { deviceId: '', enabled: true, mode: 'standard', echoCancellation: true, autoGainControl: false };
  try {
    for (const file of ['settings', 'engines', 'AudioPipeline']) {
      let source = await readFile(`src/audio/${file}.ts`, 'utf8');
      source = source.replaceAll('import.meta.env.BASE_URL', "'/'").replace("from './settings'", "from './settings.mjs'").replace("from './engines'", "from './engines.mjs'");
      await writeFile(join(dir, `${file}.mjs`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    }
    const { AudioPipeline } = await import(pathToFileURL(join(dir, 'AudioPipeline.mjs')));
    const pipeline = await AudioPipeline.create();
    await pipeline.configure(settings);
    const recordingTrack = pipeline.stream.getAudioTracks()[0];
    assert.equal(pipeline.context.sampleRate, 48000);
    assert.equal(pipeline.status.capture.sampleRate, 44100); // Device/context rates deliberately differ.
    assert.equal(calls[0].noiseSuppression, true);
    const oldTrack = captures[0].getAudioTracks()[0];
    const captureCount = captures.length;
    await pipeline.configure({ ...settings, voiceCleanup: true, gateThresholdDb: -35 });
    assert.equal(captures.length, captureCount, 'cleanup adjustment keeps the microphone open');
    assert.equal(oldTrack.readyState, 'live');
    await pipeline.configure({ ...settings, mode: 'ai' });
    assert.equal(pipeline.status.active, 'standard');
    assert.match(pipeline.status.message, /AI unavailable/);
    assert.equal(oldTrack.readyState, 'ended');
    assert.equal(pipeline.stream.getAudioTracks()[0], recordingTrack);
    aiAssets = true;
    await pipeline.configure({ ...settings, deviceId: 'new-mic', mode: 'ai' });
    assert.equal(calls.at(-1).noiseSuppression, false);
    assert.equal(pipeline.status.active, 'ai');
    assert.equal(pipeline.graph.output, pipeline.graph.ai);
    assert.ok(pipeline.graph.output.connections.includes(pipeline.bus));
    assert.equal(pipeline.stream.getAudioTracks()[0], recordingTrack);
    pipeline.setMuted(true); assert.equal(captures.at(-1).getAudioTracks()[0].enabled, false);
    pipeline.setMuted(false); assert.equal(captures.at(-1).getAudioTracks()[0].enabled, true);
    const good = pipeline.graph;
    rejectCapture = true;
    await assert.rejects(pipeline.configure({ ...settings, deviceId: 'broken' }), /unavailable/);
    assert.equal(pipeline.graph, good); assert.equal(good.stream.getAudioTracks()[0].readyState, 'live');
    rejectCapture = false;
    await pipeline.configure(settings);
    pipeline.graph.stream.getAudioTracks()[0].onended();
    await pipeline.queue;
    assert.equal(pipeline.status.active, 'standard');
    assert.equal(pipeline.stream.getAudioTracks()[0], recordingTrack);
    await pipeline.close();
    assert.equal(recordingTrack.readyState, 'ended');
    assert.ok(captures.every(stream => stream.getAudioTracks()[0].readyState === 'ended'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
