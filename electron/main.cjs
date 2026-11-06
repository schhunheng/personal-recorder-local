const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, powerSaveBlocker, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RecordingStore } = require('./recording-store.cjs');
const store = new RecordingStore();
const videoExport = require('./export-video.cjs');
let lastRecording;
let exporting = false;
let window, selectedSource, blocker;
const devURL = process.env.RECORDER_DEV === '1' ? 'http://127.0.0.1:5173' : null;
const indexURL = 'recorder://app/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'recorder', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
function trusted(url) { return url === indexURL || (devURL && url === `${devURL}/`); }
function assertSender(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw Error('Unauthorized IPC');
}
function handle(name, action) { ipcMain.handle(name, (event, ...args) => { assertSender(event); return action(event, ...args); }); }
function releasePower() { if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); blocker = undefined; }
app.whenReady().then(() => {
  const root = path.resolve(__dirname, '../dist');
  protocol.handle('recorder', request => {
    const url = new URL(request.url);
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (url.hostname !== 'app' || !target.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).href);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = contents === window?.webContents && trusted(details.requestingUrl) && ['media', 'display-capture'].includes(permission);
    callback(Boolean(allowed));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    return contents === window?.webContents && trusted(details.requestingUrl ?? contents.getURL()) && ['media', 'display-capture'].includes(permission);
  });
  // Runtime never connects to an external host. Dev mode only allows the local Vite server.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const local = ['recorder:', 'file:', 'blob:', 'data:', 'devtools:'].includes(url.protocol) ||
      (devURL && ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port === '5173');
    callback({ cancel: !local });
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!trusted(request.frame.url) || !selectedSource) { callback({}); return; }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find(item => item.id === selectedSource);
      selectedSource = undefined;
      callback(source ? { video: source } : {});
    } catch { callback({}); }
  });
  handle('capture:sources', async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 140 } }))
    .map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })));
  handle('capture:select', (_event, id) => { if (typeof id !== 'string') throw Error('Invalid source'); selectedSource = id; });
  handle('recording:begin', async (event, format = 'webm') => {
    if (!['webm', 'mp4'].includes(format)) throw Error('Invalid recording format');
    const { canceled, filePath } = await dialog.showSaveDialog(window, { title: 'Save local recording', defaultPath: `Recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`, filters: [{ name: `${format.toUpperCase()} video`, extensions: [format] }] });
    if (canceled || !filePath) return null;
    const result = await store.begin(filePath.toLowerCase().endsWith(`.${format}`) ? filePath : `${filePath}.${format}`, event.sender.id);
    blocker = powerSaveBlocker.start('prevent-display-sleep');
    return result;
  });
  handle('recording:append', (event, id, data) => {
    if (!(data instanceof ArrayBuffer)) throw Error('Invalid chunk');
    return store.append(id, event.sender.id, new Uint8Array(data));
  });
  handle('recording:finish', async (event, id, preservePartial) => {
    try {
      const result = await store.finish(id, event.sender.id, Boolean(preservePartial));
      if (!preservePartial) lastRecording = { owner: event.sender.id, path: result };
      return result;
    } finally { releasePower(); }
  });
  handle('export:capabilities', () => videoExport.capabilities());
  handle('export:video', async (event, format) => {
    if (!['mp4', 'mov'].includes(format)) throw Error('Choose MP4 or MOV');
    if (!lastRecording || lastRecording.owner !== event.sender.id) throw Error('No completed recording to export');
    if (exporting) throw Error('An export is already running');
    exporting = true;
    const input = lastRecording.path;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: `Export ${format.toUpperCase()} recording`, defaultPath: input.replace(/\.[^.]+$/, `-export.${format}`),
        filters: [{ name: `${format.toUpperCase()} video`, extensions: [format] }],
      });
      if (canceled || !filePath) return null;
      const output = filePath.toLowerCase().endsWith(`.${format}`) ? filePath : `${filePath}.${format}`;
      if (path.resolve(output) === path.resolve(input)) throw Error('Choose a different filename to keep the original recording');
      return await videoExport.convertFile(input, output, format);
    } finally { exporting = false; }
  });
  handle('app:metrics', () => {
    const metrics = app.getAppMetrics();
    return { cpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0), memoryMB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0) };
  });
  function createWindow() {
    window = new BrowserWindow({ width: 1250, height: 880, minWidth: 900, minHeight: 700,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
    const owner = window.webContents.id;
    window.webContents.on('render-process-gone', () => { void store.abandonOwner(owner); releasePower(); });
    window.on('close', event => {
      if (store.sessions.size || exporting) {
        event.preventDefault();
        dialog.showMessageBox(window, { message: 'Wait for recording or export to finish before closing.', buttons: ['Continue recording'] });
      }
    });
    window.on('closed', () => { void store.abandonOwner(owner); releasePower(); window = undefined; });
    if (devURL) window.loadURL(devURL); else window.loadURL(indexURL);
  }
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
