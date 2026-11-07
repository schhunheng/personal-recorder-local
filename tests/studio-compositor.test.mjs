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
const modelURL = url(await readFile('src/studio/model.ts', 'utf8')),
  timelineURL = url(
    (await readFile('src/studio/timeline.ts', 'utf8')).replace(
      "'./model'",
      JSON.stringify(modelURL)
    )
  );
const compositorURL = url(
  (await readFile('src/studio/compositor.ts', 'utf8')).replace(
    "'./timeline'",
    JSON.stringify(timelineURL)
  )
);
const { defaultEdits } = await import(modelURL),
  { drawFrame, screenBounds } = await import(compositorURL);
function context() {
  const calls = [];
  return new Proxy(
    { calls },
    {
      set: (o, k, v) => {
        o[k] = v;
        calls.push([k, v]);
        return true;
      },
      get: (o, k) => (k in o ? o[k] : (...args) => calls.push([k, ...args])),
    }
  );
}
test('rendering applies source cropping, bounded zoom, independent camera, and branding', () => {
  const edits = defaultEdits(20);
  edits.zooms = [{ id: 'z', time: 0, duration: 0.5, scale: 2, x: 1, y: 0.5 }];
  edits.appearance.watermark = true;
  edits.appearance.title = 'Python lesson';
  edits.appearance.intro = true;
  edits.camera.opacity = 0.7;
  const screen = { videoWidth: 2000, videoHeight: 1000, readyState: 4 },
    cam = { videoWidth: 640, videoHeight: 480, readyState: 4 };
  const ctx = context();
  drawFrame(ctx, screen, cam, edits, 1, 1920, 1080);
  const draws = ctx.calls.filter((c) => c[0] === 'drawImage');
  assert.equal(draws.length, 2);
  assert.deepEqual(draws[0].slice(2, 6), [1000, 250, 1000, 500]);
  assert.deepEqual(draws[1].slice(2, 6), [80, 0, 480, 480]);
  assert.ok(ctx.calls.some((c) => c[0] === 'globalAlpha' && c[1] === 0.7));
  assert.ok(ctx.calls.some((c) => c[0] === 'scale' && c[1] === -1));
  assert.ok(
    ctx.calls.some((c) => c[0] === 'fillText' && c[1] === 'REANCODE101')
  );
  assert.ok(
    ctx.calls.some((c) => c[0] === 'fillText' && c[1] === 'Python lesson')
  );
});
test('screen fitting preserves source aspect ratio for portrait and square outputs', () => {
  const e = defaultEdits(10);
  for (const [w, h] of [
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ]) {
    const b = screenBounds({ videoWidth: 2560, videoHeight: 1440 }, e, w, h);
    assert.ok(b.x >= 0 && b.y >= 0);
    assert.ok(b.x + b.w <= w && b.y + b.h <= h);
    assert.ok(Math.abs(b.w / b.h - 16 / 9) < 1e-8);
  }
});
test('hiding an overlay removes it from rendered frames and showing it restores the chosen position', () => {
  const edits = defaultEdits(10),
    screen = { videoWidth: 1920, videoHeight: 1080, readyState: 4 },
    camera = { videoWidth: 640, videoHeight: 480, readyState: 4 };
  edits.camera = {
    ...edits.camera,
    visible: false,
    x: 0.15,
    y: 0.2,
    mirror: false,
  };
  const hidden = context();
  drawFrame(hidden, screen, camera, edits, 1, 1920, 1080);
  assert.equal(hidden.calls.filter((c) => c[0] === 'drawImage').length, 1);
  edits.camera.visible = true;
  const visible = context();
  drawFrame(visible, screen, camera, edits, 1, 1920, 1080);
  assert.equal(visible.calls.filter((c) => c[0] === 'drawImage').length, 2);
  const radius = (1080 * edits.camera.size) / 2;
  assert.deepEqual(
    visible.calls.find((c) => c[0] === 'translate'),
    ['translate', 1920 * 0.15 - radius, 1080 * 0.2 - radius]
  );
});
