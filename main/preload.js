'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  syncRegistry: () => ipcRenderer.invoke('sync-registry'),
  load: (recipeId) => ipcRenderer.invoke('load', recipeId),
  unload: () => ipcRenderer.invoke('unload'),
  download: (recipeId) => ipcRenderer.invoke('download', recipeId),
  probeEndpoint: () => ipcRenderer.invoke('probe-endpoint'),
  openDsh: (cwd) => ipcRenderer.invoke('open-dsh', { cwd }),
  stopDsh: () => ipcRenderer.invoke('stop-dsh'),
});
