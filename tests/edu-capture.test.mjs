import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
class Track {
  constructor(kind) { this.kind = kind; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
  getSettings() { return { sampleRate: 48000, noiseSuppression: false }; }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
class Encoder {
  static isTypeSupported() { return true; }
  constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; Encoder.last = this; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  chunk(bytes) { this.ondataavailable({ data: new Blob([new Uint8Array(bytes)]) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk([9]); this.onstop(); }); }
}
test('EduRecorder preserves final chunks, routes raw microphone and composed video, recovers storage failure, and releases devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edu-capture-'));
  let recorder;
  try {
    const source = (await readFile('src/edu/capture.ts', 'utf8')).replace("'./storage'", "'./storage.mjs'");
    await writeFile(join(dir, 'capture.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    await writeFile(join(dir, 'storage.mjs'), `export async function saveRecording(r){ globalThis.metadata={...r}; } export async function appendChunk(id,index,blob){ if(globalThis.failDisk)throw Error('quota'); globalThis.chunks.push(blob); }`);
    const { Capture } = await import(pathToFileURL(join(dir, 'capture.mjs')));
    const drawn = [], tracks = [];
    const ctx = new Proxy({}, { get: (_, name) => (...args) => drawn.push({ name, args }) });
    const canvas = { getContext: () => ctx, captureStream: () => new Stream([track('video')]) };
    function track(kind) { const value = new Track(kind); tracks.push(value); return value; }
    globalThis.chunks = []; globalThis.failDisk = false;
    globalThis.MediaStream = Stream; globalThis.MediaRecorder = Encoder;
    globalThis.document = { createElement: () => ({ videoWidth: 1280, videoHeight: 720, readyState: 4, play: async () => {}, pause() {} }) };
    globalThis.AudioContext = class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: b => b.fill(.1) }; } };
    let requested = false;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
      getDisplayMedia: async () => { requested = true; return new Stream([track('video')]); },
      getUserMedia: async ({ video }) => new Stream([track(video ? 'video' : 'audio')]),
    } } });
    recorder = new Capture(); let saved, emergency, settings;
    recorder.onSaved = (r, b) => { saved = r; emergency = b; };
    recorder.onSettings = s => { settings = s; };
    const mic = { deviceId: 'h390', echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    const camera = { deviceId: '', enabled: true, visible: true, size: .22, x: .8, y: .8 };
    const start = recorder.start(canvas, mic, camera);
    assert.ok(requested, 'screen picker invoked synchronously from user gesture'); await start;
    assert.equal(canvas.width, 1920); assert.equal(canvas.height, 1080);
    assert.equal(Encoder.last.stream.getAudioTracks()[0], tracks.find(t => t.kind === 'audio'));
    assert.equal(settings.sampleRate, 48000);
    assert.ok(drawn.some(call => call.name === 'arc'), 'camera is part of the canvas');
    Encoder.last.chunk([1, 2]); recorder.pause(); assert.equal(recorder.state, 'paused'); recorder.resume();
    const stopping = recorder.stop(); assert.equal(recorder.stop(), stopping); await stopping;
    assert.deepEqual([...new Uint8Array(await new Blob(globalThis.chunks).arrayBuffer())], [1, 2, 9]);
    assert.ok(saved.complete && saved.bytes === 3 && tracks.every(t => t.readyState === 'ended'));
    assert.equal(recorder.state, 'idle');
    // A test after a recording must still be cancellable, not reuse the old stop promise.
    const testing = recorder.test(mic);
    await new Promise(resolve => setTimeout(resolve, 10)); await recorder.stop();
    const testAudio = await testing; assert.equal(testAudio.size, 1);
    // Stop automatically on disk error, keep unsaved chunks for emergency download.
    globalThis.chunks = []; globalThis.failDisk = true;
    await recorder.start(canvas, mic, { ...camera, enabled: false });
    Encoder.last.chunk([4, 5]);
    await new Promise(resolve => setTimeout(resolve, 30)); await recorder.stop();
    assert.ok(emergency); assert.deepEqual([...new Uint8Array(await emergency.arrayBuffer())], [4, 5, 9]);
    assert.ok(tracks.every(t => t.readyState === 'ended'));
    globalThis.failDisk = false;
    // Stopping sharing finalizes and releases both microphone and video.
    await recorder.start(canvas, mic, { ...camera, enabled: false });
    const liveScreen = tracks.find(t => t.kind === 'video' && t.readyState === 'live');
    liveScreen.onended(); await recorder.stop();
    assert.equal(recorder.state, 'idle');
    assert.ok(tracks.every(t => t.readyState === 'ended'));
    // Microphone permission failure also releases the already-shared screen.
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => { throw Error('Mic denied'); };
    await assert.rejects(recorder.start(canvas, mic, camera), /Mic denied/);
    assert.ok(tracks.every(t => t.readyState === 'ended'));
    navigator.mediaDevices.getUserMedia = getUserMedia;
    // Permission denial returns to idle and a subsequent attempt remains possible.
    navigator.mediaDevices.getDisplayMedia = async () => { throw Error('Permission denied'); };
    await assert.rejects(recorder.start(canvas, mic, camera), /Permission denied/);
    assert.equal(recorder.state, 'idle');
  } finally { await recorder?.stop(); await rm(dir, { recursive: true, force: true }); }
});
