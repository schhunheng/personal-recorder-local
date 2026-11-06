import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const url = (source) =>
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpile(source, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    })
  ).toString('base64');
const model = url(await readFile('src/studio/model.ts', 'utf8'));
const storage = url(
  `export const saveProject=p=>globalThis.harness.save(p); export const deleteProject=p=>globalThis.harness.deleted.push(p.id); export const deleteAsset=p=>globalThis.harness.deleted.push(p.id); export class AssetWriter { constructor(mime){this.asset={id:crypto.randomUUID(),mime,bytes:0,storage:'idb'};this.pending=0;} async open(){globalThis.harness.writers.push(this);return this;} async append(b){if(globalThis.harness.failWrite)throw Error('quota');this.asset.bytes+=b.size;globalThis.harness.chunks.push(b);} async close(){return this.asset;} }`
);
const caps = url(
  `export const recordingMime=()=>'video/webm;codecs=vp8,opus'; export const mediaError=e=>e.message;`
);
const recorderURL = url(
  (await readFile('src/studio/recorder.ts', 'utf8'))
    .replace("'./model'", JSON.stringify(model))
    .replace("'./storage'", JSON.stringify(storage))
    .replace("'./capabilities'", JSON.stringify(caps))
);
const { StudioRecorder } = await import(recorderURL),
  { defaultRecording } = await import(model);
const originalTimer = globalThis.setTimeout;
class Track {
  readyState = 'live';
  onended = null;
  constructor(kind) {
    this.kind = kind;
  }
  getSettings() {
    return { width: 1920, height: 1080 };
  }
  stop() {
    this.readyState = 'ended';
  }
  end() {
    this.readyState = 'ended';
    this.onended?.();
  }
}
class Stream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}
class Recorder {
  state = 'inactive';
  static all = [];
  constructor(stream) {
    this.stream = stream;
    Recorder.all.push(this);
  }
  start() {
    this.state = 'recording';
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  emit() {
    this.ondataavailable?.({ data: new Blob(['capture']) });
  }
  stop() {
    this.emit();
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}
let now = 0,
  allTracks = [],
  saves = [],
  r;
function setup() {
  now = 0;
  allTracks = [];
  saves = [];
  Recorder.all = [];
  globalThis.harness = {
    deleted: [],
    writers: [],
    chunks: [],
    failWrite: false,
    save: async (p) => {
      saves.push(structuredClone(p));
    },
  };
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => now },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: { persist: async () => true },
      mediaDevices: {
        getDisplayMedia: async () => {
          const t = new Track('video');
          allTracks.push(t);
          return new Stream([t]);
        },
        getUserMedia: async () => {
          const t = new Track('video');
          allTracks.push(t);
          return new Stream([t]);
        },
      },
    },
  });
  globalThis.MediaStream = Stream;
  globalThis.MediaRecorder = Recorder;
  globalThis.setTimeout = (fn, ms, ...args) =>
    ms === 1000
      ? originalTimer(fn, 0, ...args)
      : originalTimer(fn, ms, ...args);
  r = new StudioRecorder();
}
const flush = () => new Promise((resolve) => originalTimer(resolve, 10));
test('real lifecycle orchestration records separate sources, excludes pause time, and saves before releasing tracks', async () => {
  setup();
  let saved;
  r.onSaved = (p) => (saved = p);
  await r.start({ ...defaultRecording, mic: false, camera: true });
  assert.equal(r.state, 'recording');
  assert.equal(Recorder.all.length, 2);
  assert.equal(Recorder.all[0].stream.getVideoTracks()[0], allTracks[0]);
  assert.equal(Recorder.all[1].stream.getVideoTracks()[0], allTracks[1]);
  now = 2000;
  r.pause();
  assert.equal(r.seconds, 2);
  now = 9000;
  r.resume();
  now = 12000;
  assert.equal(r.seconds, 5);
  await Promise.all([r.stop(), r.stop()]);
  assert.equal(saved.duration, 5);
  assert.ok(saved.complete);
  assert.ok(saved.camera);
  assert.equal(saved.screen.bytes, 7);
  assert.equal(saved.camera.bytes, 7);
  assert.ok(allTracks.every((t) => t.readyState === 'ended'));
  assert.equal(r.state, 'idle');
});
test('cancelling while browser picker is pending releases the late stream and creates no empty project', async () => {
  setup();
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  navigator.mediaDevices.getDisplayMedia = () => pending;
  const starting = r.start({ ...defaultRecording, mic: false });
  const stopping = r.stop();
  const t = new Track('video');
  allTracks.push(t);
  release(new Stream([t]));
  await starting;
  await stopping;
  assert.equal(t.readyState, 'ended');
  assert.equal(saves.length, 0);
  assert.equal(r.state, 'idle');
});
test('browser Stop sharing finalizes a recoverable recording', async () => {
  setup();
  let saved;
  r.onSaved = (p) => (saved = p);
  await r.start({ ...defaultRecording, mic: false });
  now = 4000;
  allTracks[0].end();
  await flush();
  assert.equal(saved.duration, 4);
  assert.equal(r.state, 'idle');
});
test('quota failure stops recording and marks incomplete instead of claiming success', async () => {
  setup();
  let saved;
  r.onSaved = (p) => (saved = p);
  await r.start({ ...defaultRecording, mic: false });
  now = 6000;
  globalThis.harness.failWrite = true;
  Recorder.all[0].emit();
  await flush();
  assert.ok(saved);
  assert.equal(saved.complete, false);
  assert.equal(r.state, 'idle');
  assert.ok(allTracks.every((t) => t.readyState === 'ended'));
});
test('permission denial leaves the recorder retryable', async () => {
  setup();
  let error;
  r.onError = (e) => (error = e);
  const original = navigator.mediaDevices.getDisplayMedia;
  navigator.mediaDevices.getDisplayMedia = async () => {
    throw new DOMException('Permission declined', 'NotAllowedError');
  };
  await r.start({ ...defaultRecording, mic: false });
  assert.match(error, /declined/);
  assert.equal(r.state, 'idle');
  navigator.mediaDevices.getDisplayMedia = original;
  await r.start({ ...defaultRecording, mic: false });
  now = 1000;
  await r.stop();
  assert.equal(r.state, 'idle');
});
