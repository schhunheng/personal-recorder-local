const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, access, rename } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const formats = {
  mp4: { mime: 'video/mp4', label: 'MP4' },
  mov: { mime: 'video/quicktime', label: 'MOV' },
};
function exportArgs(input, output, format) {
  if (!['mp4', 'mov'].includes(format)) throw Error('Choose MP4 or MOV');
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', format, output];
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-65536); });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(Error('Video export timed out. The original recording is still available.')); }, 10 * 60 * 1000);
    child.on('error', error => { clearTimeout(timer); reject(Error(error.code === 'ENOENT' ? 'FFmpeg is not installed. Install FFmpeg and restart the app to export MP4/MOV.' : error.message)); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(Error(errors || 'Video conversion failed. The original recording is still available.')); });
  });
}
async function capabilities() {
  try {
    const encoders = await run(['-hide_banner', '-encoders']);
    if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) throw Error('FFmpeg needs libx264 and AAC encoders to export MP4/MOV.');
    return { available: true, formats: ['mp4', 'mov'], message: '' };
  } catch (error) { return { available: false, formats: [], message: error.message }; }
}
async function convert(input, output, format) {
  await run(exportArgs(input, output, format));
  await access(output);
}
async function convertBytes(bytes, format) {
  if (!['mp4', 'mov'].includes(format)) throw Error('Choose MP4 or MOV');
  const dir = await mkdtemp(join(tmpdir(), 'recorder-export-'));
  try {
    const { writeFile } = require('node:fs/promises');
    const input = join(dir, 'source'); const output = join(dir, `recording.${format}`);
    await writeFile(input, bytes);
    await convert(input, output, format);
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function convertFile(input, output, format) {
  // Keep the destination untouched until conversion completes successfully.
  const temp = join(dirname(output), `.recorder-export-${randomUUID()}.${format}`);
  try { await convert(input, temp, format); await rename(temp, output); return output; }
  finally { await rm(temp, { force: true }); }
}
module.exports = { formats, exportArgs, capabilities, convertBytes, convertFile };
