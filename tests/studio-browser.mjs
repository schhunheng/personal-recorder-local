// Uses real MediaRecorder, IndexedDB, Canvas, Web Audio and the production bundle.
// Only physical screen/device acquisition is replaced with deterministic fixtures.
import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
// Serve real loopback HTTP so AudioWorklet modules use the browser's native loader.
// Intercepted HTTPS fixtures can leave audioWorklet.addModule waiting indefinitely.
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname
    );
    const file = path.resolve(
      'dist',
      pathname === '/' ? 'index.html' : '.' + pathname
    );
    if (!file.startsWith(path.resolve('dist') + path.sep))
      throw Error('Invalid path');
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.json')
        ? 'application/json'
        : 'text/javascript',
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page
    .getByRole('heading', { name: 'Your next great lesson starts here.' })
    .waitFor();
  await mkdir('/tmp/reancode101-tests', { recursive: true });
  await page.screenshot({
    path: '/tmp/reancode101-tests/dashboard.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'New recording', exact: true })
    .first()
    .click();
  await page.evaluate(() => {
    window.fixtureTracks = [];
    window.denyScreen = true;
    window.fixtureContexts = [];
    const makeVideo = (color) => {
      const c = document.createElement('canvas');
      c.width = color ? 480 : 1280;
      c.height = color ? 480 : 720;
      const ctx = c.getContext('2d');
      const draw = () => {
        ctx.fillStyle = color || '#d33232';
        ctx.fillRect(0, 0, c.width, c.height);
        if (!color) {
          ctx.fillStyle = '#20c6c6';
          ctx.fillRect(640, 0, 640, 720);
          ctx.fillStyle = '#fff';
          ctx.font = '25px monospace';
          ctx.fillText('Python tutorial', 700, 100);
        }
      };
      draw();
      const stream = c.captureStream(30);
      window.fixtureTracks.push(...stream.getTracks());
      const timer = setInterval(() => {
        draw();
        if (stream.getVideoTracks()[0].readyState === 'ended')
          clearInterval(timer);
      }, 33);
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (!navigator.userActivation.isActive)
        throw Error('Screen capture lost click activation');
      if (window.denyScreen) {
        window.denyScreen = false;
        throw new DOMException('Denied', 'NotAllowedError');
      }
      return makeVideo();
    };
    navigator.mediaDevices.getUserMedia = async (options) => {
      if (options.video) return makeVideo('#f7b34e');
      const audio = new AudioContext(),
        osc = audio.createOscillator(),
        gain = audio.createGain(),
        dest = audio.createMediaStreamDestination();
      osc.frequency.value = 220;
      gain.gain.value = 0.1;
      osc.connect(gain).connect(dest);
      osc.start();
      await audio.resume();
      window.fixtureContexts.push(audio);
      window.fixtureTracks.push(...dest.stream.getTracks());
      return dest.stream;
    };
  });
  await page.getByRole('switch', { name: /^Record webcam/ }).check();
  await page.getByRole('button', { name: 'Top left', exact: true }).click();
  await page.getByRole('slider', { name: /^Overlay size/ }).fill('26');
  const showOverlay = page.getByRole('switch', {
    name: /^Show camera \/ avatar/,
  });
  const overlay = page.getByRole('group', {
    name: 'Camera overlay. Drag to reposition.',
    exact: true,
  });
  await overlay.waitFor();
  await showOverlay.uncheck();
  assert.equal(await overlay.count(), 0);
  await showOverlay.check();
  await page
    .getByRole('button', { name: 'Start recording', exact: true })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Permission was declined' })
    .waitFor();
  await page
    .getByRole('button', { name: 'Start recording', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Pause', exact: true })
    .waitFor({ timeout: 15000 });
  await showOverlay.uncheck();
  assert.equal(await overlay.count(), 0);
  assert.ok(
    await page.evaluate(() =>
      window.fixtureTracks.every((t) => t.readyState === 'live')
    )
  );
  await showOverlay.check();
  await page.getByRole('button', { name: 'Bottom left', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForTimeout(2000);
  await page
    .getByRole('button', { name: 'Stop recording', exact: true })
    .click();
  await page.getByLabel('Project title').waitFor();
  assert.ok(
    await page.evaluate(() =>
      window.fixtureTracks.every((t) => t.readyState === 'ended')
    )
  );
  // Stopping opens editable settings and waits for the user's Auto edit click.
  const automaticSettings = page.getByRole('region', { name: 'Settings step' });
  await automaticSettings.waitFor();
  assert.ok(
    await automaticSettings
      .getByRole('button', { name: 'Auto edit', exact: true })
      .isEnabled()
  );
  assert.equal(await page.getByRole('region', { name: 'Process step' }).count(), 0);
  await page.getByLabel('Project title').fill('Python · integration fixture');
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'Bottom left', exact: true })
      .getAttribute('aria-pressed'),
    'true'
  );
  assert.equal(
    await page.getByRole('slider', { name: /^Overlay size/ }).inputValue(),
    '26'
  );
  await page.getByRole('button', { name: 'Bottom right', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom', exact: true }).click();
  await page.getByRole('button', { name: /^Add zoom at/ }).click();
  await page.getByRole('slider', { name: /^Zoom level/ }).fill('2');
  await page.getByRole('slider', { name: /^Focus X/ }).fill('0.75');
  await page.getByRole('slider', { name: /^Focus Y/ }).fill('0.5');
  await page.getByLabel('Seek video').fill('1.5');
  await page.screenshot({
    path: '/tmp/reancode101-tests/editor.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  const maskPreview = page.getByLabel('Video preview. Draw, move, or resize hidden areas.', { exact: true });
  const point = async ([x, y]) => {
    const box = await maskPreview.boundingBox();
    const size = await maskPreview.evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
    const scale = Math.min(box.width / size.width, box.height / size.height);
    return {
      x: box.x + (box.width - size.width * scale) / 2 + x * size.width * scale,
      y: box.y + (box.height - size.height * scale) / 2 + y * size.height * scale,
    };
  };
  const drag = async (from, to) => {
    const start = await point(from), end = await point(to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  };
  await drag([0.18, 0.28], [0.36, 0.5]);
  await page.getByRole('button', { name: /^Hidden area 1/ }).waitFor();
  const areaLeft = page.getByRole('slider', { name: /^Area left/ });
  const drawnLeft = +(await areaLeft.inputValue());
  await drag([0.27, 0.39], [0.31, 0.43]);
  assert.ok(+(await areaLeft.inputValue()) > drawnLeft, 'dragging a cover moves it');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(+(await areaLeft.inputValue()), drawnLeft, 'one drag is one undo step');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const areaWidth = page.getByRole('slider', { name: /^Area width/ });
  const previousWidth = +(await areaWidth.inputValue());
  await drag([0.4, 0.54], [0.44, 0.58]);
  assert.ok(+(await areaWidth.inputValue()) > previousWidth, 'the corner handle resizes a cover');
  await areaWidth.fill('10');
  await page.getByRole('slider', { name: /^Area height/ }).fill('10');
  await areaLeft.fill('60');
  await page.getByRole('slider', { name: /^Area top/ }).fill('40');
  await page.getByLabel('Hide from (seconds)', { exact: true }).fill('0.5');
  await page.getByLabel('Hide until (seconds)', { exact: true }).fill('3.2');
  await page.getByRole('button', { name: 'Add hidden area', exact: true }).click();
  await page.getByRole('button', { name: /^Hidden area 2/ }).waitFor();
  await page.getByRole('button', { name: 'Remove hidden area', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Hidden area 2/ }).count(), 0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Hidden area 2/ }).count(), 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Hidden area 2/ }).count(), 0);
  await page.getByRole('button', { name: /^Hidden area 1/ }).click();
  await page.screenshot({ path: '/tmp/reancode101-tests/hide-editor.png', fullPage: true });
  await page.getByRole('button', { name: 'Trim', exact: true }).click();
  await page.getByLabel('Trim start (seconds)').fill('0.3');
  await page.getByLabel('Trim end (seconds)').fill('3.5');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove section 1', exact: true })
    .click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByRole('switch', { name: /^Local voice cleanup/ }).check();
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Resolution', { exact: true }).selectOption('720');
  const mp4 = await page.evaluate(() =>
    MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E,mp4a.40.2')
  );
  await dialog
    .getByLabel('Format', { exact: true })
    .selectOption(mp4 ? 'mp4' : 'webm');
  await dialog
    .getByRole('button', { name: 'Export video', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: /Download finished video/ })
    .waitFor({ timeout: 30000 });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Download finished video/ }).click();
  const downloaded = await downloadPromise;
  await downloaded.saveAs(
    '/tmp/reancode101-tests/' + downloaded.suggestedFilename()
  );
  const verification = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('reancode101-studio');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const getAll = (name) =>
      new Promise((resolve) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => resolve(r.result);
      });
    const projects = await getAll('projects'),
      savedExports = await getAll('exports');
    const p = projects[0],
      asset = savedExports.sort((a, b) => b.created - a.created)[0].asset;
    let blob;
    if (asset.storage === 'opfs') {
      const root = await navigator.storage.getDirectory(),
        dir = await root.getDirectoryHandle('reancode101-studio');
      blob = await (await dir.getFileHandle(asset.id)).getFile();
    } else {
      const chunks = (await getAll('chunks'))
        .filter((c) => c.id === asset.id)
        .sort((a, b) => a.index - b.index);
      blob = new Blob(
        chunks.map((c) => c.blob),
        { type: asset.mime }
      );
    }
    const url = URL.createObjectURL(blob),
      v = document.createElement('video');
    v.src = url;
    await new Promise((resolve, reject) => {
      v.onloadeddata = resolve;
      v.onerror = reject;
    });
    v.currentTime = 1;
    await new Promise((resolve) => (v.onseeked = resolve));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const center = [...ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data],
      camera = [
        ...ctx.getImageData(
          c.width * p.edits.camera.x,
          c.height * p.edits.camera.y,
          1,
          1
        ).data,
      ];
    const mask = p.edits.masks[0], pad = Math.min(c.width, c.height) * p.edits.appearance.padding,
      scale = Math.min((c.width - pad * 2) / p.width, (c.height - pad * 2) / p.height),
      bw = p.width * scale, bh = p.height * scale,
      covered = [...ctx.getImageData(
        (c.width - bw) / 2 + ((mask.x + mask.width / 2 - 0.75) * 2 + 0.5) * bw,
        (c.height - bh) / 2 + ((mask.y + mask.height / 2 - 0.5) * 2 + 0.5) * bh,
        1, 1
      ).data];
    const header = new TextDecoder().decode(
      await blob.slice(4, 8).arrayBuffer()
    );
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(
      await blob.arrayBuffer()
    );
    const samples = decoded.getChannelData(0);
    const rms = Math.sqrt(
      samples.reduce((sum, n) => sum + n * n, 0) / samples.length
    );
    const audioDuration = decoded.duration;
    await audioContext.close();
    URL.revokeObjectURL(url);
    db.close();
    return {
      rms,
      audioDuration,
      center,
      camera,
      covered,
      masks: p.edits.masks,
      header,
      width: v.videoWidth,
      height: v.videoHeight,
      bytes: blob.size,
      duration: v.duration,
      originalBytes: p.screen.bytes,
    };
  });
  assert.equal(verification.width, 1280);
  assert.equal(verification.height, 720);
  assert.ok(verification.rms > 0.001, 'processed audio must remain audible');
  assert.ok(
    Math.abs(verification.audioDuration - 2) < 0.3,
    'trim and split removal must be represented in exported duration'
  );
  assert.ok(verification.bytes > 10000);
  assert.ok(verification.covered.slice(0, 3).every((channel) => channel < 25), 'exported pixels must hide the selected screen area');
  assert.equal(verification.masks.length, 1);
  assert.ok(
    verification.center[1] > 140 &&
      verification.center[2] > 140 &&
      verification.center[0] < 90,
    'zoom must select cyan code area'
  );
  assert.ok(
    verification.camera[0] > 180 &&
      verification.camera[1] > 80 &&
      verification.camera[2] < 130,
    'separate webcam must be composited'
  );
  if (mp4) assert.equal(verification.header, 'ftyp');
  await page.getByRole('button', { name: 'Close export settings' }).click();
  await page
    .getByRole('button', { name: 'Back to projects', exact: true })
    .click();
  await page.reload();
  await page
    .getByRole('button', { name: 'Python · integration fixture', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Python · integration fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.getByRole('button', { name: /^Hidden area 1/ }).click();
  assert.equal(await page.getByRole('slider', { name: /^Area left/ }).inputValue(), '60');
  assert.equal(await page.getByLabel('Hide from (seconds)', { exact: true }).inputValue(), '0.5');
  assert.equal(await page.getByLabel('Hide until (seconds)', { exact: true }).inputValue(), '3.2');
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  // Regression: leaving the editor and reloading must retain both video files.
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  await page
    .getByRole('link', { name: 'Download original', exact: true })
    .waitFor();
  const originalSize = await page
    .getByLabel('Original recording playback')
    .evaluate(async (video) => (await (await fetch(video.src)).blob()).size);
  assert.equal(originalSize, verification.originalBytes);
  await page.getByRole('button', { name: 'Close saved videos' }).click();
  await page.getByRole('button', { name: /^Edited videos/ }).click();
  await page
    .getByRole('link', { name: 'Download edited video', exact: true })
    .waitFor();
  const retainedSize = await page
    .getByLabel('Edited video playback')
    .evaluate(async (video) => (await (await fetch(video.src)).blob()).size);
  assert.equal(
    retainedSize,
    verification.bytes,
    'saved edited output must survive editor exit and page reload'
  );
  const retainedDownload = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Download edited video', exact: true })
    .click();
  assert.equal(
    (await readFile(await (await retainedDownload).path())).length,
    verification.bytes
  );
  await page.getByRole('button', { name: 'Close saved videos' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/reancode101-tests/mobile.png',
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1
    )
  );
  assert.deepEqual(errors, []);
  await writeFile(
    '/tmp/reancode101-tests/result.json',
    JSON.stringify(verification, null, 2)
  );
  console.log(
    'Capture, pause/resume, storage restore, zoom, hidden-area editing and export pixels, separate webcam, local export and responsive checks passed.',
    verification
  );
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: '/tmp/reancode101-tests/failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
