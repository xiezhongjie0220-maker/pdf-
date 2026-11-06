const { contextBridge, ipcRenderer, webUtils } = require('electron');
const fs = require('fs');

contextBridge.exposeInMainWorld('pdfAPI', {
  // Electron 33 起 File.path 被移除，通过 webUtils 获取拖拽文件路径
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // 读取文件大小
  statFile: (filePath) => {
    try {
      return { size: fs.statSync(filePath).size };
    } catch {
      return null;
    }
  },
  selectFiles: () => ipcRenderer.invoke('select-files'),
  compressFile: (payload) => ipcRenderer.invoke('compress-file', payload),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
});
