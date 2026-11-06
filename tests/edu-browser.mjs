import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['microphone', 'camera'] });
  await context.route('https://edu.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/')) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Backend offline for browser-only test"}' }); return; }
    const file = path.join(process.cwd(), 'dist', pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(path.join(process.cwd(), 'dist') + path.sep)) { await route.abort(); return; }
    try { await route.fulfill({ body: await readFile(file), contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript' }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://edu.test/');
  await page.getByRole('heading', { name: 'Record. Refine. Teach.' }).waitFor();
  await page.screenshot({ path: '/tmp/edurecorder-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.screenshot({ path: '/tmp/edurecorder-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Test microphone · 5 sec' }).click();
  await page.getByLabel('Microphone test playback').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start recording' }).isEnabled(), true);
  await page.evaluate(() => {
    window.captureTracks = []; let first = true;
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (!navigator.userActivation.isActive) throw Error('Lost user activation');
      if (first) { first = false; throw new DOMException('Screen sharing cancelled', 'NotAllowedError'); }
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(30);
      window.captureTracks.push(...stream.getTracks());
      const timer = setInterval(() => { ctx.fillStyle = '#18454e'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#fff'; ctx.font = '30px monospace'; ctx.fillText('function teach() { return "Hello, world!"; }', 50, 100); ctx.fillText(String(performance.now().toFixed()), 50, 150); if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer); }, 33);
      return stream;
    };
  });
  await page.getByRole('switch', { name: 'Camera overlay', exact: true }).check();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('alert').filter({ hasText: 'Screen sharing cancelled' }).waitFor();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.timer')?.textContent.includes('00:02'));
  const canvas = page.getByLabel('Recorded composition preview. Drag to position camera.');
  await canvas.focus(); await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.screenshot({ path: '/tmp/edurecorder-live.png', fullPage: true });
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('link', { name: 'Original', exact: true }).waitFor();
  const media = await page.getByRole('link', { name: 'Original', exact: true }).evaluate(async link => {
    const blob = await (await fetch(link.href)).blob();
    const audio = new AudioContext();
    const decoded = await audio.decodeAudioData(await blob.arrayBuffer());
    const data = decoded.getChannelData(0);
    const rms = Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
    await audio.close();
    return { bytes: blob.size, duration: decoded.duration, rms, tracksEnded: window.captureTracks.every(t => t.readyState === 'ended') };
  });
  assert.ok(media.bytes > 1000 && media.duration > 1 && media.rms > .0001, JSON.stringify(media));
  assert.ok(media.tracksEnded);
  assert.equal(await page.getByRole('button', { name: 'Clean audio & create MP4' }).isDisabled(), true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Original', exact: true }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^edu-original-.*\.webm$/);
  assert.equal(await download.failure(), null);
  await page.reload();
  await page.locator('.record-list button').first().click();
  await page.getByRole('link', { name: 'Original', exact: true }).waitFor();
  const recovered = await page.getByRole('link', { name: 'Original', exact: true }).evaluate(async link => (await (await fetch(link.href)).blob()).size);
  assert.equal(recovered, media.bytes);
  await page.screenshot({ path: '/tmp/edurecorder-review.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/edurecorder-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile('docs/edu-browser-results.json', JSON.stringify({ checkedAt: new Date().toISOString(), ...media, recoveredBytes: recovered, pageErrors: errors }, null, 2));
  console.log('PASS: permission denial and retry, mic test, actual MediaRecorder audio/video, camera composition, pause/resume, download, track cleanup, IndexedDB recovery, themes and mobile overflow.');
  console.log(JSON.stringify(media));
} finally { await browser.close(); }
