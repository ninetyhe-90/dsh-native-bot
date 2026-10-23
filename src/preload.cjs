/**
 * 渲染层唯一的能力出口。没有 node，只有这几个方法。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  submit: (text) => ipcRenderer.invoke('pet:submit', text),
  requestState: () => ipcRenderer.invoke('pet:state'),
  setComposerOpen: (open) => ipcRenderer.invoke('pet:composer', open),
  openMenu: () => ipcRenderer.send('pet:menu'),
  quit: () => ipcRenderer.send('pet:quit'),
  onState: (handler) => {
    ipcRenderer.on('pet:state', (_event, state) => handler(state))
  },
})
