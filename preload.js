const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  chooseFile: kind => ipcRenderer.invoke('choose-file', kind),
  chooseOutputFolder: currentPath => ipcRenderer.invoke('choose-output-folder', currentPath),
  start: config => ipcRenderer.invoke('start', config),
  pause: () => ipcRenderer.invoke('pause'),
  reset: () => ipcRenderer.invoke('reset'),
  openResults: () => ipcRenderer.invoke('open-results'),
  exportPending: () => ipcRenderer.invoke('export-pending'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('run-state', listener);
    return () => ipcRenderer.removeListener('run-state', listener);
  }
});
