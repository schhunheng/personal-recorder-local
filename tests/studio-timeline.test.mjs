import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const moduleURL = (source) =>
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpile(source, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    })
  ).toString('base64');
const modelURL = moduleURL(await readFile('src/studio/model.ts', 'utf8'));
const timelineURL = moduleURL(
  (await readFile('src/studio/timeline.ts', 'utf8')).replace(
    "'./model'",
    JSON.stringify(modelURL)
  )
);
const { defaultEdits } = await import(modelURL);
const { mergeRanges, segments, editedDuration, zoomAt, detectSilence, updateSilenceSuggestions } =
  await import(timelineURL);
test('overlapping cuts are merged, bounded, and preserve the original timeline', () => {
  const e = defaultEdits(30);
  e.trim = { start: 2, end: 28 };
  e.cuts = [
    { start: -3, end: 4 },
    { start: 7, end: 12 },
    { start: 10, end: 14 },
    { start: 26, end: 90 },
  ];
  const before = structuredClone(e);
  assert.deepEqual(segments(e), [
    { start: 4, end: 7 },
    { start: 14, end: 26 },
  ]);
  assert.equal(editedDuration(e), 15);
  assert.deepEqual(e, before);
  assert.deepEqual(
    mergeRanges(
      [
        { start: NaN, end: 8 },
        { start: 5, end: 3 },
      ],
      e.trim
    ),
    []
  );
});
test('a smooth zoom is continuous at boundaries and never crops beyond source bounds', () => {
  const zooms = [
    { id: 'a', time: 1, duration: 1, scale: 3, x: 0, y: 1 },
    { id: 'b', time: 4, duration: 1, scale: 1, x: 0.5, y: 0.5 },
  ];
  assert.deepEqual(zoomAt(zooms, 0), { scale: 1, x: 0.5, y: 0.5 });
  assert.equal(zoomAt(zooms, 1).scale, 1);
  assert.equal(zoomAt(zooms, 1.5).scale, 2);
  assert.equal(zoomAt(zooms, 2).scale, 3);
  assert.equal(zoomAt(zooms, 5).scale, 1);
  for (let t = 0; t < 6; t += 0.01) {
    const z = zoomAt(zooms, t),
      edge = 0.5 / z.scale;
    assert.ok(z.x >= edge && z.x <= 1 - edge);
    assert.ok(z.y >= edge && z.y <= 1 - edge);
  }
  assert.ok(
    Math.abs(zoomAt(zooms, 1.0001).scale - zoomAt(zooms, 0.9999).scale) <
      0.00001
  );
});
test('silence detection protects speech edges and keeps short natural pauses', () => {
  const levels = [
    ...Array(10).fill(0.2),
    ...Array(30).fill(0.001),
    ...Array(10).fill(0.2),
    ...Array(5).fill(0.001),
    ...Array(10).fill(0.2),
  ];
  const result = detectSilence(levels, 0.1, -40, 1.2);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].start - 1.4) < 1e-6);
  assert.ok(Math.abs(result[0].end - 3.6) < 1e-6);
  assert.deepEqual(detectSilence(Array(100).fill(0.2), 0.1, -40, 1), []);
});
test('quiet words interrupt silence suggestions and entirely quiet recordings stay intact', () => {
  const levels = [
    ...Array(10).fill(.1), ...Array(20).fill(.0001),
    ...Array(4).fill(.004), ...Array(20).fill(.0001),
    ...Array(10).fill(.1),
  ];
  const cuts = detectSilence(levels, .1, -38, 1.2);
  assert.equal(cuts.length, 2);
  for (const cut of cuts) assert.ok(cut.end <= 2.6 || cut.start >= 3.8);
  assert.deepEqual(detectSilence(Array(100).fill(.0001), .1, -38, 1.2), []);
  assert.deepEqual(detectSilence([], .1, -38, 1.2), []);
  assert.deepEqual(detectSilence([.1, 0, .1], 0, -38, 1.2), []);
});
test('updating pause choices replaces old automatic cuts while preserving manual cuts and undo data', () => {
  const edits = defaultEdits(20);
  edits.cuts = [{ start: 2, end: 5 }, { start: 10, end: 11 }];
  edits.silence = [{ start: 2, end: 5 }];
  const before = structuredClone(edits);
  const suggestions = [{ start: 2.4, end: 4.6 }];
  const review = updateSilenceSuggestions(edits, suggestions);
  assert.deepEqual(review.cuts, edits.cuts);
  const applied = updateSilenceSuggestions(review, suggestions, suggestions);
  assert.deepEqual(applied.cuts, [...suggestions, { start: 10, end: 11 }]);
  assert.deepEqual(updateSilenceSuggestions(applied, suggestions, []).cuts, [{ start: 10, end: 11 }]);
  assert.deepEqual(edits, before);
});
test('30-minute timeline calculations remain bounded with many edits', () => {
  const e = defaultEdits(1800);
  e.cuts = Array.from({ length: 300 }, (_, i) => ({
    start: i * 6 + 2,
    end: i * 6 + 3,
  }));
  assert.equal(editedDuration(e), 1500);
  assert.equal(segments(e).length, 301);
  const removed = defaultEdits(10);
  removed.cuts = [{ start: 0, end: 10 }];
  assert.equal(editedDuration(removed), 0);
});
