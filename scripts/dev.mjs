import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const env = { ...process.env };
if (existsSync('backend/.env')) for (const line of readFileSync('backend/.env', 'utf8').split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.*)$/); if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
if (!existsSync(python)) { console.error('Run python3 -m venv .venv and .venv/bin/pip install -r backend/requirements.txt first.'); process.exit(1); }
const dependencies = spawnSync(python, ['-c', [
  'import importlib, sys',
  'errors = []',
  "for module in ('uvicorn', 'fastapi', 'numpy', 'soundfile', 'noisereduce'):",
  '    try: importlib.import_module(module)',
  '    except Exception as error: errors.append(f"{module}: {error}")',
  'print("\\n".join(errors))',
  'sys.exit(bool(errors))',
].join('\n')], { encoding: 'utf8', env });
if (dependencies.error || dependencies.status !== 0) {
  console.error('The Python backend dependencies are missing or could not load.');
  console.error(dependencies.error?.message || dependencies.stdout.trim() || dependencies.stderr.trim());
  console.error(`\nInstall them into this virtual environment, then start again:\n\n  ${python} -m pip install -r backend/requirements.txt\n  npm run dev:all\n`);
  process.exit(1);
}
if (env.EDU_PORT && env.EDU_PORT !== '8001') { console.error('The Vite proxy uses port 8001. Update vite.config.ts before using another backend port.'); process.exit(1); }
const children = [spawn(python, ['-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', '8001'], { stdio: 'inherit', env }), spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', env })];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
children.forEach(child => { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code || 0)); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
