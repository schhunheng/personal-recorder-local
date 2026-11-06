import { copyFile, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const target = new URL('../public/audio/', import.meta.url);
await mkdir(target, { recursive: true });
let available = false;
try {
  const root = dirname(require.resolve('@jitsi/rnnoise-wasm/package.json'));
  const source = join(root, 'dist/rnnoise-sync.js');
  await access(source);
  await copyFile(source, new URL('rnnoise-sync.js', target));
  await mkdir(new URL('licenses/', target), { recursive: true });
  // Package filenames vary; retain all license notices shipped by this release.
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(root)) {
    if (/license|copying|notice/i.test(name)) await copyFile(join(root, name), new URL(`licenses/${name}`, target));
  }
  available = true;
} catch (error) {
  await rm(new URL('rnnoise-sync.js', target), { force: true });
  console.warn('RNNoise assets unavailable. AI will fall back visibly to Standard:', error.message);
}
await writeFile(new URL('engine.json', target), JSON.stringify({ rnnoise: available, package: '@jitsi/rnnoise-wasm', version: '0.2.1' }));
if (process.env.REQUIRE_RNNOISE === '1' && !available) process.exitCode = 1;
