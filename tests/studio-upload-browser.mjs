// Real file import, local upload, RNNoise processing, A/B review and MP4 download.
// Static assets and the API use temporary localhost servers and an isolated library.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createServer, request as httpRequest } from 'node:http';

const run = promisify(execFile);
const folder = await mkdtemp(path.join(tmpdir(), 'studio-upload-'));
const fixture = path.join(folder, 'Uploaded lesson.mp4');
await run('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x20c6c6:s=640x360:r=30',
  '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.025:sample_rate=48000:seed=7',
  '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', fixture,
]);
const port = process.env.STUDIO_TEST_PORT || '18081';
const api = `http://127.0.0.1:${port}`;
const server = spawn('.venv/bin/python', [
  '-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', port,
], {
  env: { ...process.env, EDU_DATA_DIR: path.join(folder, 'data'), EDU_RECORDINGS_DIR: path.join(folder, 'Recordings') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, frontend;
let submissions = 0, offline = false;
server.stdout.on('data', (data) => { logs += data; });
server.stderr.on('data', (data) => { logs += data; });
try {
  let caps;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error(logs);
    try {
      const response = await fetch(`${api}/api/studio/capabilities`);
      if (response.ok) { caps = await response.json(); break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(caps?.ready, logs || 'Local test API did not start');
  assert.ok(caps.audio_engines.some((e) => e.id === 'rnnoise' && e.available));
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  frontend = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      if (offline) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Local service unavailable for test. Your original is safe.' }));
        return;
      }
      if (pathname.endsWith('/process')) submissions++;
      const upstream = httpRequest(`${api}${request.url}`, {
        method: request.method,
        // The production API permits the studio's default origin. The test
        // frontend uses a free port to avoid interfering with an open studio.
        headers: { ...request.headers, origin: 'http://127.0.0.1:5173' },
      }, (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502);
        response.end(error.message);
      });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    const file = path.resolve('dist', pathname === '/' ? 'index.html' : '.' + decodeURIComponent(pathname));
    if (!file.startsWith(path.resolve('dist') + path.sep)) {
      response.writeHead(403); response.end(); return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript' });
      response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => {
    frontend.once('error', reject);
    frontend.listen(0, '127.0.0.1', resolve);
  });
  const studioURL = `http://127.0.0.1:${frontend.address().port}`;
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(studioURL);
  await page.getByRole('button', { name: 'Upload video', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload video' });
  const input = dialog.getByLabel('Video file');
  assert.equal(await dialog.getByRole('switch', { name: /^AI noise cancellation/ }).isChecked(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Continue to editor' }).isDisabled(), true);
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a video') });
  await dialog.getByRole('alert').filter({ hasText: 'Choose an MP4' }).waitFor();
  await input.setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('corrupted video') });
  await dialog.getByRole('button', { name: 'Continue to editor' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Unsupported or corrupted video' }).waitFor();
  await input.setInputFiles(fixture);
  await dialog.getByLabel('Noise cancellation strength').selectOption('strong');
  await page.screenshot({ path: path.join(folder, 'upload.png') });
  await dialog.getByRole('button', { name: 'Continue to editor' }).click();
  const remove = page.getByRole('button', { name: 'Remove noise', exact: true });
  await remove.waitFor();
  assert.equal(submissions, 0, 'Importing must not start processing');
  assert.equal(await page.getByRole('switch', { name: /^Noise cancellation only/ }).isChecked(), true);
  assert.equal(await page.getByLabel('Noise reduction', { exact: true }).inputValue(), 'strong');
  assert.equal(await page.getByLabel('Audio source', { exact: true }).inputValue(), 'screen');
  assert.equal(await page.getByLabel('Editing preset', { exact: true }).count(), 0);
  offline = true;
  await remove.click();
  await page.getByRole('alert').filter({ hasText: 'Local service unavailable for test' }).waitFor();
  assert.equal(submissions, 0);
  offline = false;
  await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
  await page.getByRole('switch', { name: /^Normalize voice volume/ }).uncheck();
  await remove.click();
  await page.getByRole('region', { name: 'Review step', exact: true }).waitFor({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('video[aria-label="Automatic edited preview"]')?.readyState >= 2);
  assert.equal(submissions, 1);
  await page.getByText('Used: RNNoise 0.2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Original audio', exact: true }).click();
  await page.getByLabel('Original audio comparison').waitFor();
  await page.getByRole('button', { name: 'Cleaned voice', exact: true }).click();
  await page.getByLabel('Cleaned audio comparison').waitFor();
  await page.screenshot({ path: path.join(folder, 'review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Next: download video', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download MP4', exact: true }).click();
  const download = await downloadEvent;
  const output = await readFile(await download.path());
  assert.equal(output.subarray(4, 8).toString(), 'ftyp');
  const projects = await (await fetch(`${api}/api/studio/projects`)).json();
  assert.equal(projects.length, 1);
  const job = await (await fetch(`${api}/api/studio/jobs/${projects[0].latest_job_id}`)).json();
  assert.equal(job.options.action, 'render');
  assert.equal(job.options.noise, 'strong');
  assert.equal(job.result.audio.engine, 'rnnoise');
  assert.equal(job.result.audio.source, 'screen');
  assert.deepEqual(job.result.edl.cuts, []);
  const original = Buffer.from(await (await fetch(`${api}/api/studio/projects/${projects[0].id}/assets/screen`)).arrayBuffer());
  assert.deepEqual(original, await readFile(fixture));
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Uploaded lesson', exact: true }).click();
  await page.getByRole('region', { name: 'Review step', exact: true }).waitFor();
  assert.equal(submissions, 1, 'Reopening must reuse the finished job');
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Upload a video', exact: true }).first().click();
  await input.setInputFiles(fixture);
  await dialog.getByRole('switch', { name: /^AI noise cancellation/ }).uncheck();
  assert.equal(await dialog.getByLabel('Noise cancellation strength').count(), 0);
  await page.screenshot({ path: path.join(folder, 'upload-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await dialog.getByRole('button', { name: 'Continue to editor' }).click();
  await page.getByRole('button', { name: 'Automatic editor' }).waitFor();
  assert.equal(await remove.count(), 0, 'Import-only leaves automatic settings collapsed');
  assert.equal(submissions, 1);
  assert.deepEqual(errors, []);
  await writeFile(path.join(folder, 'result.json'), JSON.stringify({ job: job.id, model: job.result.audio.model, bytes: output.length }, null, 2));
  console.log(`Upload, offline retry, real RNNoise cleanup, original preservation, A/B review, MP4 download and reload passed. Artifacts: ${folder}`);
} catch (error) {
  console.error(`Browser test artifacts: ${folder}`);
  throw error;
} finally {
  await browser?.close();
  if (frontend) {
    frontend.closeAllConnections();
    await new Promise((resolve) => frontend.close(resolve));
  }
  server.kill('SIGTERM');
  await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
}
