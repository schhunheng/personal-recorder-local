// Offline RNNoise 0.2 inference using the neural model already shipped by Jitsi.
// Input/output: mono 48 kHz float32 little-endian PCM. No network or media upload.
import {
  readFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@jitsi/rnnoise-wasm/package.json'));
const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
).version;
if (version !== '0.2.1')
  throw Error('Use the pinned @jitsi/rnnoise-wasm 0.2.1 package.');
const code = readFileSync(join(root, 'dist/rnnoise-sync.js'), 'utf8');
const { default: factory } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
const module = factory();
for (const key of [
  '_rnnoise_create',
  '_rnnoise_destroy',
  '_rnnoise_process_frame',
  '_malloc',
  '_free',
]) {
  if (typeof module[key] !== 'function')
    throw Error(`RNNoise export missing: ${key}`);
}
const state = module._rnnoise_create(0),
  pointer = module._malloc(480 * 4);
if (!state || !pointer) throw Error('RNNoise allocation failed.');
let input, output;
try {
  if (process.argv[2] === '--check') {
    module.HEAPF32.fill(0, pointer >>> 2, (pointer >>> 2) + 480);
    module._rnnoise_process_frame(state, pointer, pointer);
    if (!Number.isFinite(module.HEAPF32[pointer >>> 2]))
      throw Error('RNNoise self-test failed.');
    console.log(
      JSON.stringify({
        engine: 'rnnoise',
        model: 'RNNoise 0.2',
        package_version: version,
        delay_samples: 960,
      })
    );
  } else {
    const [source, target] = process.argv.slice(2);
    if (!source || !target)
      throw Error('Usage: node scripts/rnnoise.mjs input.f32 output.f32');
    const bytes = statSync(source).size;
    if (bytes % 4 || bytes === 0) throw Error('Invalid float32 PCM input.');
    const samples = bytes / 4,
      frameCount = Math.ceil(samples / 480);
    input = openSync(source, 'r');
    output = openSync(target, 'wx');
    const block = Buffer.alloc(48000 * 4),
      result = Buffer.alloc(480 * 4);
    let blockOffset = 0,
      blockLength = 0,
      written = 0;
    for (let frame = 0; frame < frameCount + 2; frame++) {
      const offset = pointer >>> 2;
      for (let i = 0; i < 480; i++) {
        if (blockOffset === blockLength && frame * 480 + i < samples) {
          blockLength = readSync(input, block, 0, block.length, null);
          blockOffset = 0;
          if (!blockLength || blockLength % 4)
            throw Error('Incomplete PCM source.');
        }
        module.HEAPF32[offset + i] =
          frame * 480 + i < samples
            ? block.readFloatLE((blockOffset += 4) - 4) * 32768
            : 0;
      }
      module._rnnoise_process_frame(state, pointer, pointer);
      // RNNoise 0.2 has one analysis frame plus one lookahead frame of latency.
      // Flush both frames and discard that delay, retaining the exact source length.
      if (frame >= 2) {
        const count = Math.min(480, samples - written);
        for (let i = 0; i < count; i++) {
          const value = module.HEAPF32[offset + i] / 32768;
          if (!Number.isFinite(value) || Math.abs(value) > 4)
            throw Error('Invalid RNNoise output.');
          result.writeFloatLE(value, i * 4);
        }
        let at = 0;
        while (at < count * 4)
          at += writeSync(output, result, at, count * 4 - at);
        written += count;
        if (frame % 100 === 0)
          console.log(`out_time_us=${Math.round((written / 48000) * 1e6)}`);
      }
    }
    if (written !== samples) throw Error('RNNoise output length mismatch.');
    console.log(`out_time_us=${Math.round((samples / 48000) * 1e6)}`);
  }
} finally {
  if (input !== undefined) closeSync(input);
  if (output !== undefined) closeSync(output);
  module._rnnoise_destroy(state);
  module._free(pointer);
}
