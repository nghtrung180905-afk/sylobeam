'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swiftdropDesktop', {
  isDesktop: true,
  runtime: 'electron',
  platform: process.platform,
  setRemoteControlAuth: (enabled) => ipcRenderer.invoke('rc:set-auth', Boolean(enabled)),
  sendInput: (cmd) => ipcRenderer.send('rc:input', cmd),
  getScreenInfo: () => ipcRenderer.invoke('rc:screen-info'),
  getScreenSources: () => ipcRenderer.invoke('rc:get-sources'),
  getHardwareInfo: () => ipcRenderer.invoke('rc:hardware-info'),
  getSessionToken: () => ipcRenderer.invoke('rc:session-token'),
  setScreenConfig: (cfg) => ipcRenderer.invoke('rc:screen-config', cfg),
  stopScreenStream: () => ipcRenderer.invoke('rc:screen-stop'),
  saveFile: (fileName, data) => ipcRenderer.invoke('rc:save-file', { fileName, data }),
  openDownloadsFolder: (filePath) => ipcRenderer.invoke('rc:open-downloads', filePath || ''),
  getDownloadDir: () => ipcRenderer.invoke('rc:get-download-dir'),
  setDownloadDir: (downloadsDir) => ipcRenderer.invoke('rc:set-download-dir', downloadsDir || ''),
  chooseDownloadDir: () => ipcRenderer.invoke('rc:choose-download-dir'),
  onEmergencyStop: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('rc:emergency-stop', handler);
    return () => ipcRenderer.removeListener('rc:emergency-stop', handler);
  }
});
