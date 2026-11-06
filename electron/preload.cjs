const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  sources: () => ipcRenderer.invoke('capture:sources'),
  selectSource: id => ipcRenderer.invoke('capture:select', id),
  beginRecording: format => ipcRenderer.invoke('recording:begin', format),
  appendRecording: (id, data) => ipcRenderer.invoke('recording:append', id, data),
  finishRecording: (id, preservePartial) => ipcRenderer.invoke('recording:finish', id, preservePartial),
  exportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  exportVideo: format => ipcRenderer.invoke('export:video', format),
  metrics: () => ipcRenderer.invoke('app:metrics'),
});
