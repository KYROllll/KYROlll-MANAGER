'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kyrolll', {
  getSnapshot: () => ipcRenderer.invoke('hub:snapshot'),
  refreshCatalog: () => ipcRenderer.invoke('hub:refresh-catalog'),
  checkAppUpdate: () => ipcRenderer.invoke('hub:check-app-update'),
  install: (pluginId) => ipcRenderer.invoke('hub:install', pluginId),
  uninstall: (pluginId) => ipcRenderer.invoke('hub:uninstall', pluginId),
  cancelInstall: (runId) => ipcRenderer.invoke('hub:cancel-install', runId),
  open: (target) => ipcRenderer.invoke('hub:open', target),
  openExternal: (url) => ipcRenderer.invoke('hub:open-external', url),
  onInstallProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('hub:install-progress', listener);
    return () => ipcRenderer.removeListener('hub:install-progress', listener);
  },
  onSnapshotUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('hub:snapshot-updated', listener);
    return () => ipcRenderer.removeListener('hub:snapshot-updated', listener);
  },
});
