import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const result = await build({
  stdin: {
    contents: "export * from './src/studio/import'; export * from './src/studio/pipeline';",
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  createRequire(import.meta.url), mod, mod.exports
);
const { uploadedVideoMime, uploadedProject, projectPipelineOptions, noiseCancellationRequest, defaultPipeline, toEDL } = mod.exports;

test('uploads normalize missing MIME types and supported browser aliases', () => {
  for (const [name, type, expected] of [
    ['lesson.MP4', '', 'video/mp4'],
    ['lesson.mov', 'application/octet-stream', 'video/quicktime'],
    ['lesson.m4v', 'video/x-m4v', 'video/mp4'],
    ['lesson.webm', 'video/webm;codecs=vp8,opus', 'video/webm'],
    ['lesson.mkv', 'video/matroska', 'video/x-matroska'],
    ['lesson.ogv', '', 'video/ogg'],
  ]) assert.equal(uploadedVideoMime({ name, type, size: 42 }), expected);
  for (const [name, type, size] of [
    ['lesson.mp4', 'video/mp4', 0], ['photo.mp4', 'image/png', 42],
    ['sound.ogg', 'audio/ogg', 42], ['notes.txt', '', 42],
  ]) assert.throws(() => uploadedVideoMime({ name, type, size }));
});

test('uploaded videos retain originals and open cleanup settings without starting a job', () => {
  const asset = { id: 'original', mime: 'video/mp4', bytes: 123, storage: 'idb' };
  const project = uploadedProject({ name: 'My lesson.mp4' }, asset,
    { duration: 12, width: 1080, height: 1920 }, { enabled: true, noise: 'strong' });
  assert.equal(project.screen, asset);
  assert.equal(project.title, 'My lesson');
  assert.deepEqual(project.edits.trim, { start: 0, end: 12 });
  assert.deepEqual(project.edits.cuts, []);
  assert.deepEqual(project.edits.zooms, []);
  assert.equal(project.edits.appearance.padding, 0);
  assert.equal(project.edits.appearance.ratio, '9:16');
  assert.deepEqual(project.processing, { requested: true, mode: 'denoise', noise: 'strong' });
  assert.equal(project.processing.jobId, undefined);
  const importedOnly = uploadedProject({ name: 'My lesson.mp4' }, asset,
    { duration: 12, width: 1920, height: 1080 }, { enabled: false, noise: 'light' });
  assert.equal(importedOnly.processing.requested, false);
  assert.equal(importedOnly.processing.mode, 'edit');
});

test('upload cleanup ignores stale social, microphone-only and disabled-noise preferences', () => {
  const project = uploadedProject({ name: 'Video.mp4' }, { id: 'original' },
    { duration: 12, width: 1280, height: 720 }, { enabled: true, noise: 'light' });
  const preferences = { ...defaultPipeline, preset: 'social', profile: 'vertical',
    noise: 'off', noise_engine: 'spectral', noise_strength: 0,
    audio_source: 'microphone', transcribe: true };
  const options = projectPipelineOptions(project, preferences);
  assert.equal(options.preset, 'clean');
  assert.equal(options.profile, 'lms');
  assert.equal(options.noise, 'light');
  assert.equal(options.noise_engine, 'auto');
  assert.equal(options.noise_strength, null);
  assert.equal(options.audio_source, 'screen');
  const edl = toEDL(project);
  const request = noiseCancellationRequest({ ...options, preset: 'social', action: 'plan', transcribe: true, accept_silence: true, edl });
  assert.equal(request.action, 'render');
  assert.equal(request.preset, 'clean');
  assert.equal(request.accept_silence, false);
  assert.equal(request.transcribe, false);
  assert.equal(request.edl, edl);
  assert.equal(preferences.preset, 'social');
});
