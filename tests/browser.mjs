import { chromium } from 'playwright-core';
import { readFile, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import assert from 'node:assert/strict';
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 1000 } });
  const root = path.resolve('.');
  // Intercept local test origin rather than opening a server socket. No audio leaves the machine.
  await context.route('https://recorder.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    try {
      let file = path.join(root, pathname.startsWith('/src/') ? pathname : `/dist${pathname === '/' ? '/index.html' : pathname}`);
      if (pathname.startsWith('/src/') && !path.extname(file)) file += '.ts';
      if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
      let body = await readFile(file);
      let contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/javascript';
      if (file.endsWith('.ts')) body = Buffer.from(ts.transpileModule(body.toString().replaceAll('import.meta.env.BASE_URL', "'/'"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
      await route.fulfill({ body, contentType });
    } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://recorder.test/');
  await page.getByRole('button', { name: 'Enable microphone' }).click();
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/recorder-ui.png', fullPage: true });
  console.log('PASS React settings UI connects to real AudioWorklet graph');
  // Exercise the browser UI without Electron IPC. Only the OS picker is replaced.
  await page.evaluate(() => {
    let canceled = false;
    window.browserCaptureTracks = [];
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (!navigator.userActivation.isActive) throw Error('Screen capture lost the Start button gesture');
      if (!canceled) { canceled = true; throw new DOMException('Sharing canceled', 'NotAllowedError'); }
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      window.browserCaptureTracks.push(...stream.getTracks());
      const timer = setInterval(() => { ctx.fillStyle = '#345678'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillText(String(performance.now()), 10, 30); if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer); }, 33);
      return stream;
    };
  });
  await page.getByRole('checkbox', { name: 'Circular webcam' }).uncheck();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('alert').filter({ hasText: 'Sharing canceled' }).waitFor();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  // Wait for actual encoded chunks rather than merely asserting a download link exists.
  await page.waitForFunction(() => document.querySelector('.preview-label')?.textContent === '00:02');
  const automaticDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stop & save' }).click();
  const automaticDownload = await automaticDownloadEvent;
  assert.match(automaticDownload.suggestedFilename(), /^recording-.*\.webm$/);
  assert.equal(await automaticDownload.failure(), null);
  const downloadLink = page.getByRole('link', { name: 'Download recording (.webm) again' });
  await downloadLink.waitFor();
  await page.getByRole('status').filter({ hasText: 'Location: your browser' }).waitFor();
  assert.equal(await downloadLink.evaluate(link => Boolean(link.closest('.panel'))), true);
  const browserVideo = await downloadLink.evaluate(async link => {
    const blob = await (await fetch(link.href)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { size: blob.size, header: Array.from(bytes.slice(0, 4)), released: window.browserCaptureTracks.every(track => track.readyState === 'ended') };
  });
  assert.ok(browserVideo.size > 1000);
  assert.deepEqual(browserVideo.header, [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(browserVideo.released);
  const downloadEvent = page.waitForEvent('download');
  await downloadLink.click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^recording-.*\.webm$/);
  assert.equal(await download.failure(), null);
  console.log('PASS browser Start gesture, canceled sharing and retry, pause/resume, WebM download and capture cleanup');
  const result = await page.evaluate(async () => {
    const { AudioPipeline } = await import('/src/audio/AudioPipeline.ts');
    const { ScreenRecorder } = await import('/src/recording/ScreenRecorder.ts');
    const { compareMicrophone } = await import('/src/audio/comparison.ts');
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settings = { deviceId: '', enabled: true, mode: 'off', echoCancellation: false, autoGainControl: false };
    // Deterministic capture fixture: 440 Hz tone, avoiding assertions on a real room/device.
    const tone = new AudioContext({ sampleRate: 48000 }); await tone.resume();
    const oscillator = tone.createOscillator(); oscillator.frequency.value = 440;
    const gain = tone.createGain(); gain.gain.value = 0.2;
    const toneDestination = tone.createMediaStreamDestination(); oscillator.connect(gain).connect(toneDestination); oscillator.start();
    const captureCalls = [];
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async ({ audio, video }) => {
      if (video && !audio) return originalGetUserMedia({ video });
      captureCalls.push(audio);
      const stream = toneDestination.stream.clone();
      stream.getAudioTracks()[0].getSettings = () => ({ sampleRate: 48000, noiseSuppression: audio.noiseSuppression });
      return stream;
    };
    const pipeline = await AudioPipeline.create();
    await pipeline.configure(settings);
    const id = pipeline.stream.getAudioTracks()[0].id;
    const meter = pipeline.context.createAnalyser(); pipeline.context.createMediaStreamSource(pipeline.stream).connect(meter);
    const samples = new Float32Array(meter.fftSize);
    const rms = () => { meter.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); };
    await pause(250); const audible = rms();
    pipeline.setMuted(true); await pause(250); const muted = rms();
    pipeline.setMuted(false);
    await pipeline.configure({ ...settings, deviceId: 'replacement-fixture', mode: 'standard' });
    const standard = pipeline.status;
    const changedTrackStable = id === pipeline.stream.getAudioTracks()[0].id;
    await pipeline.configure({ ...settings, mode: 'ai' });
    const ai = pipeline.status;
    const aiCalls = captureCalls.slice();
    const comparison = await compareMicrophone(pipeline, new AbortController().signal, 0.5);
    const sizes = await Promise.all([comparison.before, comparison.after].map(async url => (await (await fetch(url)).blob()).size));
    URL.revokeObjectURL(comparison.before); URL.revokeObjectURL(comparison.after);
    // Exercise actual video composition, pause/resume and muxing with an in-memory IPC fixture.
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); const screen = canvas.captureStream(30);
    const draw = setInterval(() => { ctx.fillStyle = '#345678'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.fillText(String(performance.now()), 10, 30); }, 33);
    navigator.mediaDevices.getDisplayMedia = async () => screen;
    const chunks = [];
    window.desktop = { selectSource: async () => {}, beginRecording: async () => ({ id: 'test', path: 'fixture.webm' }), appendRecording: async (_id, bytes) => chunks.push(bytes), finishRecording: async () => 'fixture.webm' };
    const recorder = new ScreenRecorder();
    const states = []; recorder.onState = state => states.push(state);
    const failures = []; recorder.onError = error => failures.push(error.message);
    await recorder.start(pipeline.stream, { sourceId: 'test', webcam: true });
    await pause(1100); recorder.pause(); await pause(200); recorder.resume(); await pause(1100);
    const trackDuringRecording = pipeline.stream.getAudioTracks()[0].id;
    await pipeline.configure(settings); await pause(300);
    const trackStableInRecording = trackDuringRecording === pipeline.stream.getAudioTracks()[0].id;
    await recorder.stop(); clearInterval(draw);
    const video = new Blob(chunks, { type: 'video/webm' });
    const decoded = await tone.decodeAudioData(await video.arrayBuffer());
    const audio = decoded.getChannelData(0);
    const recordingRms = Math.sqrt(audio.reduce((sum, x) => sum + x * x, 0) / audio.length);
    // Device-ended recovery is asynchronous; destination track stays alive and connected.
    pipeline.graph.stream.getAudioTracks()[0].dispatchEvent(new Event('ended'));
    await pause(300);
    const recovered = pipeline.status.active !== 'disconnected' && pipeline.stream.getAudioTracks()[0].id === id;
    await pipeline.close(); await tone.close();
    return { audible, muted, changedTrackStable, trackStableInRecording, standard, ai, aiCalls, sizes, states, failures, videoBytes: video.size, recordingRms, recovered };
  });
  assert.ok(result.audible > 0.05, JSON.stringify(result));
  assert.ok(result.muted < 0.00001);
  assert.equal(result.standard.active, 'standard');
  assert.ok(result.changedTrackStable && result.trackStableInRecording && result.recovered);
  const manifest = JSON.parse(await readFile('dist/audio/engine.json', 'utf8'));
  assert.equal(result.ai.active, manifest.rnnoise ? 'ai' : 'standard');
  if (!manifest.rnnoise) assert.match(result.ai.message, /AI unavailable/);
  assert.ok(result.sizes.every(size => size > 100));
  assert.deepEqual(result.states, ['recording', 'paused', 'recording', 'saving', 'idle']);
  assert.equal(result.failures.length, 0); assert.ok(result.videoBytes > 1000 && result.recordingRms > 0.01);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile('docs/browser-results.json', JSON.stringify({ date: new Date().toISOString(), rnnoiseVerified: manifest.rnnoise && result.ai.active === 'ai', ...result }, null, 2));
  console.log('PASS mute, switching, stable recording audio track, engine fallback, paired samples, device recovery, webcam composition, pause/resume, decoded muxed audio');
  console.log(JSON.stringify({ audibleRms: result.audible, mutedRms: result.muted, recordingRms: result.recordingRms, videoBytes: result.videoBytes, rnnoiseVerified: manifest.rnnoise }, null, 2));
} finally { await browser.close(); }
