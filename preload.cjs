const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vaultApp', {
  load: () => ipcRenderer.invoke('vault:load'),
  save: value => ipcRenderer.invoke('vault:save', value),
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: value => ipcRenderer.invoke('file:save', value),
  openDataDirectory: () => ipcRenderer.invoke('app:data-directory'),
  openExternal: url => ipcRenderer.invoke('app:external-link', url),
  themeState: () => ipcRenderer.invoke('theme:state'),
  setTheme: source => ipcRenderer.invoke('theme:set', source),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: callback => { const listener = (_, state) => callback(state); ipcRenderer.on('update:state', listener); return () => ipcRenderer.removeListener('update:state', listener); },
  onCommand: callback => { const listener = (_, command) => callback(command); ipcRenderer.on('app:command', listener); return () => ipcRenderer.removeListener('app:command', listener); }
});
