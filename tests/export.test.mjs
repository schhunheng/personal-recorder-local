import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { exportPlugin } from '../scripts/export-plugin.mjs';
const videoExport = createRequire(import.meta.url)('../electron/export-video.cjs');
const exec = promisify(execFile);

test('MP4 and MOV export use real muxers with H.264/AAC and do not rename the source', () => {
  for (const format of ['mp4', 'mov']) {
    const args = videoExport.exportArgs('source with spaces.webm', `destination.${format}`, format);
    assert.equal(args[args.indexOf('-f') + 1], format);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.ok(args.includes('+faststart'));
    assert.ok(args.includes('-n'));
    assert.equal(args[args.indexOf('-i') + 1], 'source with spaces.webm');
  }
  for (const invalid of ['webm', '__proto__', 'constructor', '', null]) assert.throws(() => videoExport.exportArgs('in', 'out', invalid), /MP4 or MOV/);
});

function middleware(converter) {
  let handler;
  exportPlugin(converter).configureServer({ config: { root: process.cwd() }, middlewares: { use: (_path, callback) => { handler = callback; } } });
  return async ({ method = 'POST', origin = 'http://127.0.0.1:5173', host = '127.0.0.1:5173', format = 'mp4', body = Buffer.from('original'), headers = {} } = {}) => {
    const request = Readable.from([body]);
    Object.assign(request, { method, url: `/?format=${format}`, headers: { host, origin, 'x-recorder-export': '1', ...headers } });
    const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; this.writableEnded = true; } };
    await handler(request, response);
    return response;
  };
}
test('local browser export checks origin, format and input before conversion and returns the right MIME', async () => {
  const converted = [];
  const request = middleware({ ...videoExport, capabilities: async () => ({ available: true }), convertBytes: async (bytes, format) => { converted.push({ bytes, format }); return Buffer.from('converted'); } });
  assert.equal((await request({ origin: 'https://untrusted.test' })).statusCode, 403);
  assert.equal((await request({ host: 'untrusted.test' })).statusCode, 403);
  assert.equal((await request({ format: '__proto__' })).statusCode, 400);
  assert.equal((await request({ body: Buffer.alloc(0) })).statusCode, 400);
  assert.equal((await request({ headers: { 'content-length': 256 * 1024 * 1024 + 1 } })).statusCode, 413);
  assert.equal(converted.length, 0);
  for (const format of ['mp4', 'mov']) {
    const response = await request({ format });
    assert.equal(response.headers['Content-Type'], videoExport.formats[format].mime);
    assert.equal(response.body.toString(), 'converted');
    assert.equal(converted.at(-1).bytes.toString(), 'original');
    assert.equal(converted.at(-1).format, format);
  }
});
test('failed browser conversion reports error and allows retry', async () => {
  let fail = true;
  const request = middleware({ ...videoExport, convertBytes: async () => { if (fail) throw Error('encoder unavailable'); return Buffer.from('ok'); } });
  const failure = await request();
  assert.equal(failure.statusCode, 500); assert.match(failure.body, /encoder unavailable/);
  fail = false;
  assert.equal((await request()).statusCode, 200);
});
test('FFmpeg integration produces MP4 and QuickTime MOV while preserving source', async t => {
  const capability = await videoExport.capabilities();
  if (!capability.available) { t.skip(capability.message); return; }
  const dir = await mkdtemp(join(tmpdir(), 'recorder-format-test-'));
  try {
    const input = join(dir, 'source.mp4');
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.3', '-c:v', 'libx264', '-c:a', 'aac', input]);
    const original = await readFile(input);
    for (const format of ['mp4', 'mov']) {
      const output = join(dir, `export.${format}`);
      await videoExport.convertFile(input, output, format);
      const bytes = await readFile(output);
      assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
      assert.equal(bytes.toString('ascii', 8, 12), format === 'mov' ? 'qt  ' : 'isom');
      assert.ok(bytes.includes(Buffer.from('avc1')) && bytes.includes(Buffer.from('mp4a')));
      assert.deepEqual(await readFile(input), original);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
