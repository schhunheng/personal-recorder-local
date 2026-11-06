import { spawnSync } from 'node:child_process';
const target = process.argv[2];
if (!['mac', 'win'].includes(target)) throw Error('Expected mac or win');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, env = process.env) => {
  const result = spawnSync(npm, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['run', 'build'], { ...process.env, REQUIRE_RNNOISE: '1' });
run(['exec', '--', 'electron-builder', `--${target}`, target === 'mac' ? '--arm64' : '--x64']);
