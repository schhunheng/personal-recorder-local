import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const output = await build({
  entryPoints: ['src/studio/captions.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports
);
const { parseSRT, toSRT, outputCaptions } = mod.exports;
test('Khmer/English SRT import preserves text, validates timestamps, and exports accurate cut timing', () => {
  const captions = parseSRT(
    '1\n00:00:01,000 --> 00:00:05,000\nសួស្តី Python\n\n2\n00:00:06,500 --> 00:00:08,000\nprint("Hello")',
    10
  );
  assert.equal(captions[0].text, 'សួស្តី Python');
  const mapped = outputCaptions({
    trim: { start: 0, end: 10 },
    cuts: [{ start: 2, end: 4 }],
    captions,
  });
  assert.equal(mapped.length, 3);
  assert.equal(mapped[1].start, 2);
  assert.equal(mapped[2].start, 4.5);
  assert.match(toSRT(mapped), /00:00:04,500 --> 00:00:06,000/);
  assert.match(toSRT(mapped), /សួស្តី Python/);
});
test('invalid or out-of-range caption times cannot corrupt the timeline', () => {
  assert.throws(
    () => parseSRT('1\n00:00:05,000 --> 00:00:01,000\nBad', 10),
    /ordered/
  );
  assert.throws(
    () => parseSRT('1\n00:00:01,000 --> 00:00:20,000\nBad', 10),
    /inside/
  );
  assert.throws(
    () => parseSRT('1\n00:99:00,000 --> 01:00:00,000\nBad', 4000),
    /Invalid/
  );
});
