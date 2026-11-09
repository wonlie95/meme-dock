const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('memeAPI', {
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: data => ipcRenderer.invoke('save-data', data),
  importImages: () => ipcRenderer.invoke('import-images'),
  getThumbnail: filePath => ipcRenderer.invoke('get-thumbnail', filePath),
  send: meme => ipcRenderer.invoke('send-meme', meme),
  deleteCategory: (category, deleteMemes) => ipcRenderer.invoke('delete-category', category, deleteMemes),
  renameCategory: (oldName, newName) => ipcRenderer.invoke('rename-category', oldName, newName)
});
