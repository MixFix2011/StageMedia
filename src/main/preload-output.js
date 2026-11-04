const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('out', {
  onCmd: fn => ipcRenderer.on('out:cmd', (_e, m) => fn(m)),
  emit: m => ipcRenderer.send('out:event', m)
});