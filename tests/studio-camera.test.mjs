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
const modelURL = url(await readFile('src/studio/model.ts', 'utf8'));
const cameraURL = url(
  (await readFile('src/studio/camera.ts', 'utf8')).replace(
    "'./model'",
    JSON.stringify(modelURL)
  )
);
const { defaultCamera } = await import(modelURL);
const { cameraAtCorner, cameraCorners, cameraRect, selectedCameraCorner } =
  await import(cameraURL);
test('corner placement retains an equal inset and keeps overlays inside landscape, square, and vertical frames', () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1080],
    [1080, 1920],
  ]) {
    for (const size of [0.08, 0.22, 0.5]) {
      for (const { id } of cameraCorners) {
        const camera = cameraAtCorner(
          { ...defaultCamera, size, visible: false },
          id,
          width / height
        );
        const rect = cameraRect(camera, width, height);
        const margin = Math.min(width, height) * 0.035;
        assert.ok(rect.left >= 0 && rect.top >= 0);
        assert.ok(
          rect.left + rect.size <= width && rect.top + rect.size <= height
        );
        assert.ok(
          Math.abs(
            (id.endsWith('left') ? rect.left : width - rect.left - rect.size) -
              margin
          ) < 1e-6
        );
        assert.ok(
          Math.abs(
            (id.startsWith('top') ? rect.top : height - rect.top - rect.size) -
              margin
          ) < 1e-6
        );
        assert.equal(selectedCameraCorner(camera, width / height), id);
        assert.equal(camera.visible, false);
      }
    }
  }
});
test('custom positions are recognized and out-of-frame centers are bounded without changing layout metadata', () => {
  const camera = { ...defaultCamera, x: 0.5, y: 0.5 };
  assert.equal(selectedCameraCorner(camera), undefined);
  const outside = { ...camera, x: -1, y: 2 };
  const rect = cameraRect(outside, 1920, 1080);
  assert.equal(rect.left, 0);
  assert.equal(rect.top + rect.size, 1080);
  assert.equal(outside.x, -1);
  assert.equal(outside.y, 2);
});
