import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const code = ts.transpile(
  await readFile('src/studio/automation-flow.ts', 'utf8'),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
);
const { processingStage, audioReady, cutsChanged, editingSteps } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
test('the stepper maps real worker states and does not invent completed stages for failures', () => {
  assert.deepEqual(editingSteps, ['Settings', 'Process', 'Review', 'Download']);
  assert.equal(processingStage(undefined, 0.4), 0);
  assert.equal(
    processingStage({ status: 'queued', stage: 'Waiting for worker' }),
    1
  );
  assert.equal(
    processingStage({ status: 'cleaning', stage: 'RNNoise inference' }),
    2
  );
  assert.equal(
    processingStage({ status: 'detecting', stage: 'Speech detection' }),
    3
  );
  assert.equal(
    processingStage({ status: 'rendering', stage: 'Rendering video' }),
    4
  );
  assert.equal(
    processingStage({
      status: 'rendering',
      stage: 'Saving edited video to Recordings',
    }),
    5
  );
  assert.equal(processingStage({ status: 'completed', stage: 'Ready' }), 6);
  assert.equal(
    processingStage({ status: 'failed', stage: 'Processing failed' }),
    -1
  );
  assert.equal(
    processingStage({ status: 'cancelled', stage: 'Cancelled' }),
    -1
  );
});
test('audio comparisons unlock only after cleanup and edited cuts require a new render', () => {
  assert.equal(audioReady({ status: 'cleaning' }), false);
  assert.equal(audioReady({ status: 'rendering', audio_ready: false }), false);
  assert.equal(audioReady({ status: 'detecting', audio_ready: true }), true);
  const cuts = [{ id: 'cut', start: 2, end: 4, accepted: true }];
  const job = { result: { edl: { cuts } } };
  assert.equal(cutsChanged({ cuts: structuredClone(cuts) }, job), false);
  assert.equal(
    cutsChanged({ cuts: [{ ...cuts[0], accepted: false }] }, job),
    true
  );
  assert.equal(cutsChanged(undefined, job), false);
});
