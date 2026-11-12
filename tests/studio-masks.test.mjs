import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/studio/masks.ts'], bundle: true, format: 'cjs', platform: 'node', write: false });
const mod = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports);
const { maskFromPoints, moveMask, resizeMask, maskPixels } = mod.exports;

test('drawing in any direction, moving, and resizing keep hidden areas inside source bounds', () => {
  const rect = maskFromPoints({ x: 0.75, y: 0.75 }, { x: 0.25, y: 0.25 });
  assert.deepEqual(rect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.deepEqual(moveMask(rect, -2, 2), { x: 0, y: 0.5, width: 0.5, height: 0.5 });
  assert.deepEqual(resizeMask(rect, 2, -2), { x: 0.25, y: 0.25, width: 0.75, height: 0.01 });
  assert.deepEqual(rect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
});

test('partial source pixels round outward so cover edges cannot expose them', () => {
  const rect = { x: 0.1234, y: 0.4567, width: 0.2345, height: 0.1234 };
  for (const [width, height] of [[1920, 1080], [1280, 720], [1080, 1920]]) {
    const pixels = maskPixels(rect, width, height);
    assert.ok(pixels.x <= rect.x * width);
    assert.ok(pixels.y <= rect.y * height);
    assert.ok(pixels.x + pixels.width >= (rect.x + rect.width) * width);
    assert.ok(pixels.y + pixels.height >= (rect.y + rect.height) * height);
  }
});
