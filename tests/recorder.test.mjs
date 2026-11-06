import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
class Track {
  constructor(kind, id) { this.kind = kind; this.id = id; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}
class Encoder {
  static isTypeSupported() { return true; }
  constructor(stream, options) { this.options = options; this.mimeType = options.mimeType; this.stream = stream; this.state = 'inactive'; Encoder.last = this; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  chunk(bytes) { this.ondataavailable({ data: new Blob([new Uint8Array(bytes)]) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk([3]); this.onstop(); }); }
}
test('desktop and browser muxing flush final chunks, preserve processed audio, support cancel/retry and release capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-mux-test-'));
  try {
    const source = await readFile('src/recording/ScreenRecorder.ts', 'utf8');
    await writeFile(join(dir, 'recorder.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
    const { ScreenRecorder } = await import(pathToFileURL(join(dir, 'recorder.mjs')));
    const screenTrack = new Track('video', 'screen'), cameraTrack = new Track('video', 'camera');
    const compositeTrack = new Track('video', 'composite'), processedTrack = new Track('audio', 'denoised-mic');
    const drawing = [];
    const ctx = new Proxy({}, { get: (_target, method) => (...args) => drawing.push({ method, args }) });
    globalThis.document = { createElement: name => name === 'video' ? { play: async () => {}, pause() {}, videoWidth: 3840, videoHeight: 2160, readyState: 4 } : { getContext: () => ctx, captureStream: () => new Stream([compositeTrack]) } };
    globalThis.MediaStream = Stream; globalThis.MediaRecorder = Encoder;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => new Stream([screenTrack]), getUserMedia: async () => new Stream([cameraTrack]) } } });
    const written = []; let finalized = 0;
    globalThis.window = { desktop: { selectSource: async () => {}, beginRecording: async () => ({ id: 'session', path: 'local.webm' }),
      appendRecording: async (_id, bytes) => { await new Promise(resolve => setTimeout(resolve, 5)); written.push(...new Uint8Array(bytes)); },
      finishRecording: async (_id, preserve) => { assert.equal(preserve, false); finalized++; return 'local.webm'; } } };
    const recorder = new ScreenRecorder();
    const states = []; recorder.onState = state => states.push(state);
    await recorder.start(new Stream([processedTrack]), { sourceId: 'screen', webcam: true });
    const cameraDraw = drawing.find(call => call.method === 'drawImage' && call.args[0].srcObject?.getVideoTracks()[0] === cameraTrack);
    assert.ok(cameraDraw, 'webcam frames are drawn into the recorded canvas');
    assert.ok(drawing.some(call => call.method === 'arc'), 'webcam overlay uses a circular clip');
    assert.deepEqual(Encoder.last.stream.getAudioTracks(), [processedTrack]);
    assert.deepEqual(Encoder.last.stream.getVideoTracks(), [compositeTrack]);
    assert.equal(Encoder.last.options.videoBitsPerSecond, 24_000_000);
    assert.equal(Encoder.last.options.audioBitsPerSecond, 192_000);
    assert.equal(compositeTrack.contentHint, 'detail');
    const screenDraw = drawing.find(call => call.method === 'drawImage');
    assert.deepEqual(screenDraw.args.slice(1), [0, 0, 3840, 2160], 'maximum detail preserves 4K source pixels');
    Encoder.last.chunk([1]); Encoder.last.chunk([2]);
    recorder.pause(); assert.equal(Encoder.last.state, 'paused');
    recorder.resume(); assert.equal(Encoder.last.state, 'recording');
    const firstStop = recorder.stop(); assert.equal(recorder.stop(), firstStop);
    assert.equal(await firstStop, 'local.webm');
    assert.deepEqual(written, [1, 2, 3]); assert.equal(finalized, 1);
    assert.deepEqual(states, ['recording', 'paused', 'recording', 'saving', 'idle']);
    assert.equal(processedTrack.readyState, 'live');
    for (const track of [screenTrack, cameraTrack, compositeTrack]) assert.equal(track.readyState, 'ended');

    // Browser capture needs no Electron bridge and must preserve every chunk,
    // including the final dataavailable event emitted by stop().
    globalThis.window = {};
    let captureCalls = 0;
    const browserScreen = new Track('video', 'browser-screen');
    navigator.mediaDevices.getDisplayMedia = async () => {
      captureCalls++;
      if (captureCalls === 1) throw new DOMException('Sharing canceled', 'NotAllowedError');
      return new Stream([browserScreen]);
    };
    const browserRecorder = new ScreenRecorder();
    const browserStates = []; browserRecorder.onState = state => browserStates.push(state);
    let downloaded;
    browserRecorder.onDownload = (blob, filename) => { downloaded = { blob, filename }; };
    await assert.rejects(browserRecorder.start(new Stream([processedTrack]), { sourceId: '', webcam: false }), /Sharing canceled/);
    assert.equal(browserRecorder.isActive, false);
    const starting = browserRecorder.start(new Stream([processedTrack]), { sourceId: '', webcam: false, quality: 'high' });
    assert.equal(captureCalls, 2, 'screen capture requested before any await');
    await starting;
    assert.equal(Encoder.last.options.videoBitsPerSecond, 12_000_000);
    const highDraw = drawing.filter(call => call.method === 'drawImage' && call.args.length === 5).at(-1);
    assert.deepEqual(highDraw.args.slice(1), [0, 0, 1920, 1080], 'High scales the 4K source down to 1080p');
    Encoder.last.chunk([4]); Encoder.last.chunk([5]);
    browserRecorder.pause(); browserRecorder.resume();
    await browserRecorder.stop();
    assert.deepEqual([...new Uint8Array(await downloaded.blob.arrayBuffer())], [4, 5, 3]);
    assert.match(downloaded.filename, /^recording-.*\.webm$/);
    assert.ok(downloaded.blob.type.startsWith('video/webm'));
    assert.deepEqual(browserStates, ['recording', 'paused', 'recording', 'saving', 'idle']);
    assert.equal(browserScreen.readyState, 'ended');
    assert.equal(processedTrack.readyState, 'live');

    const mp4Screen = new Track('video', 'mp4-screen');
    navigator.mediaDevices.getDisplayMedia = async () => new Stream([mp4Screen]);
    await browserRecorder.start(new Stream([processedTrack]), { sourceId: '', webcam: false, format: 'mp4' });
    assert.ok(Encoder.last.mimeType.startsWith('video/mp4'));
    Encoder.last.chunk([6]);
    await browserRecorder.stop();
    assert.match(downloaded.filename, /\.mp4$/);
    assert.ok(downloaded.blob.type.startsWith('video/mp4'));
    assert.deepEqual([...new Uint8Array(await downloaded.blob.arrayBuffer())], [6, 3]);
    Encoder.isTypeSupported = type => type.startsWith('video/webm');
    let pickerCalled = false;
    navigator.mediaDevices.getDisplayMedia = async () => { pickerCalled = true; return new Stream([mp4Screen]); };
    await assert.rejects(browserRecorder.start(new Stream([processedTrack]), { sourceId: '', webcam: false, format: 'mp4' }), /not supported/);
    assert.equal(pickerCalled, false, 'unsupported MP4 does not start capture or create a misleading file');

    const rejectedScreen = new Track('video', 'camera-rejected-screen');
    navigator.mediaDevices.getDisplayMedia = async () => new Stream([rejectedScreen]);
    navigator.mediaDevices.getUserMedia = async () => { throw Error('Camera permission denied'); };
    await assert.rejects(browserRecorder.start(new Stream([processedTrack]), { sourceId: '', webcam: true }), /Camera permission denied/);
    assert.equal(rejectedScreen.readyState, 'ended');
    assert.equal(browserRecorder.isActive, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
